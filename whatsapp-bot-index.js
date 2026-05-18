import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import fs from "fs"
import path from "path"

// ============================================================================
// SILENT LOGGER - BLOCKS ALL BAILEYS DEBUG OUTPUT
// ============================================================================

class SilentLogger {
    level = "silent"
    
    log() {}
    info() {}
    warn() {}
    error() {}
    debug() {}
    trace() {}
    child() { 
        return this 
    }
}

// ============================================================================
// SIMPLE CONSOLE LOGGER - ONLY BOT MESSAGES
// ============================================================================

class BotLogger {
    constructor(logFile = "bot-logs.txt") {
        this.logFile = logFile
        this.initLogFile()
    }

    initLogFile() {
        if (!fs.existsSync(this.logFile)) {
            fs.writeFileSync(this.logFile, "")
        }
    }

    getTimestamp() {
        return new Date().toLocaleTimeString()
    }

    log(type, message) {
        const timestamp = this.getTimestamp()
        const logMessage = `[${timestamp}] [${type}] ${message}`
        
        console.log(logMessage)
        
        fs.appendFileSync(this.logFile, logMessage + "\n")
    }

    info(msg) {
        this.log("INFO", msg)
    }

    success(msg) {
        this.log("SUCCESS", msg)
    }

    error(msg) {
        this.log("ERROR", msg)
    }

    command(msg) {
        this.log("COMMAND", msg)
    }

    promotion(msg) {
        this.log("PROMOTION", msg)
    }

    group(msg) {
        this.log("GROUPS", msg)
    }
}

const logger = new BotLogger()

// ============================================================================
// DATABASE MANAGER - STORES STATS AND HISTORY
// ============================================================================

class DatabaseManager {
    constructor(dbFile = "bot-database.json") {
        this.dbFile = dbFile
        this.loadDatabase()
    }

    loadDatabase() {
        try {
            if (fs.existsSync(this.dbFile)) {
                const data = fs.readFileSync(this.dbFile, "utf-8")
                this.data = JSON.parse(data)
            } else {
                this.data = {
                    stats: {
                        totalMessages: 0,
                        totalCommands: 0,
                        totalPromotions: 0,
                        totalGroupsPromoted: 0,
                        startTime: new Date().toISOString()
                    },
                    promotions: [],
                    groups: [],
                    users: []
                }
                this.saveDatabase()
            }
        } catch (err) {
            logger.error("Database load error: " + err.message)
            this.data = {
                stats: {
                    totalMessages: 0,
                    totalCommands: 0,
                    totalPromotions: 0,
                    totalGroupsPromoted: 0,
                    startTime: new Date().toISOString()
                },
                promotions: [],
                groups: [],
                users: []
            }
        }
    }

    saveDatabase() {
        try {
            fs.writeFileSync(this.dbFile, JSON.stringify(this.data, null, 2))
        } catch (err) {
            logger.error("Database save error: " + err.message)
        }
    }

    incrementMessageCount() {
        this.data.stats.totalMessages++
        this.saveDatabase()
    }

    incrementCommandCount() {
        this.data.stats.totalCommands++
        this.saveDatabase()
    }

    addPromotion(groupName, message, count, success) {
        this.data.promotions.push({
            timestamp: new Date().toISOString(),
            groupName,
            message,
            count,
            success
        })
        this.data.stats.totalPromotions++
        this.data.stats.totalGroupsPromoted += success
        this.saveDatabase()
    }

    addGroup(id, name, members) {
        const existing = this.data.groups.find(g => g.id === id)
        if (!existing) {
            this.data.groups.push({
                id,
                name,
                members,
                addedAt: new Date().toISOString()
            })
        } else {
            existing.members = members
        }
        this.saveDatabase()
    }

    getStats() {
        return this.data.stats
    }

    getPromotionHistory() {
        return this.data.promotions.slice(-20)
    }

    getAllGroups() {
        return this.data.groups
    }
}

const db = new DatabaseManager()

// ============================================================================
// RATE LIMITER - PREVENTS SPAM DETECTION
// ============================================================================

class RateLimiter {
    constructor(delayMs = 1200) {
        this.delayMs = delayMs
        this.lastActionTime = 0
    }

    async wait() {
        const now = Date.now()
        const timeSinceLastAction = now - this.lastActionTime
        
        if (timeSinceLastAction < this.delayMs) {
            const waitTime = this.delayMs - timeSinceLastAction
            await new Promise(r => setTimeout(r, waitTime))
        }
        
        this.lastActionTime = Date.now()
    }

    setDelay(delayMs) {
        this.delayMs = delayMs
    }
}

const rateLimiter = new RateLimiter(1200)

// ============================================================================
// VALIDATOR - INPUT VALIDATION AND SECURITY
// ============================================================================

class Validator {
    static isCommand(text) {
        return typeof text === "string" && text.startsWith(".")
    }

    static parseCommand(text) {
        if (!this.isCommand(text)) return null
        
        const parts = text.trim().split(/\s+/)
        const command = parts[0].substring(1).toLowerCase()
        const args = parts.slice(1)
        
        return { command, args, full: text }
    }

    static sanitize(text) {
        return text.trim().substring(0, 5000)
    }

    static validatePromoteArgs(args) {
        if (args.length < 3) {
            return {
                valid: false,
                error: "Usage: .promote <message> <n/a or attachment> <count>"
            }
        }

        const count = parseInt(args[args.length - 1])
        
        if (isNaN(count) || count < 1 || count > 1000) {
            return {
                valid: false,
                error: "Count must be between 1 and 1000"
            }
        }

        return { valid: true }
    }
}

// ============================================================================
// MESSAGE FORMATTER - CLEAN OUTPUT FORMATTING
// ============================================================================

class MessageFormatter {
    static menu() {
        return `
-- WHATSAPP BOT MENU --
-- VERSION 3.0 --

AVAILABLE COMMANDS:

1. .menu
   Display this menu

2. .groups
   List all groups you are in
   Shows group name and member count

3. .promote <message> <attachment/n-a> <count>
   Promote your message to multiple groups
   
   Parameters:
   - message: Text to promote
   - attachment: "n/a" or attachment name
   - count: Number of groups to promote to
   
   Examples:
   .promote Check this out n/a 5
   .promote Buy now image.jpg 10

----------------------------------`
    }

    static groupsList(groups, totalMembers) {
        let text = "-- YOUR GROUPS --\n\n"
        
        if (groups.length === 0) {
            return text + "No groups found"
        }

        groups.forEach((group, index) => {
            text += `${index + 1}. ${group.name}\n   Members: ${group.members}\n\n`
        })

        text += `\n-- TOTAL GROUPS: ${groups.length} --\n`
        text += `-- TOTAL MEMBERS: ${totalMembers} --`
        
        return text
    }

    static promoteStarted(count) {
        return `Starting promotion...\n\nTarget: ${count} groups\n\nPlease wait...`
    }

    static promoteCompleted(sent, failed) {
        return `Promotion completed!\n\nSent: ${sent}\nFailed: ${failed}`
    }

    static error(message) {
        return `Error: ${message}`
    }

    static paidPromote(message) {
        return `Paid Promote by KIRO\n\n${message}`
    }
}

// ============================================================================
// GROUP MANAGER - HANDLES GROUP OPERATIONS
// ============================================================================

class GroupManager {
    constructor(sock, db) {
        this.sock = sock
        this.db = db
        this.groupCache = new Map()
        this.lastFetchTime = 0
        this.cacheDuration = 60000
    }

    async getAllGroups() {
        const now = Date.now()
        
        if (this.lastFetchTime && now - this.lastFetchTime < this.cacheDuration) {
            return Array.from(this.groupCache.values())
        }

        try {
            const groups = await this.sock.groupFetchAllParticipating()
            this.groupCache.clear()

            const groupList = []
            for (const id in groups) {
                const group = groups[id]
                const groupData = {
                    id,
                    name: group.subject,
                    members: group.participants.length,
                    fetchedAt: new Date().toISOString()
                }
                
                this.groupCache.set(id, groupData)
                groupList.push(groupData)
                
                this.db.addGroup(id, group.subject, group.participants.length)
            }

            this.lastFetchTime = now
            return groupList

        } catch (err) {
            logger.error("Get all groups error: " + err.message)
            return Array.from(this.groupCache.values())
        }
    }

    async sendToGroup(groupId, message) {
        try {
            await this.sock.sendMessage(groupId, { text: message })
            return true
        } catch (err) {
            logger.error(`Failed to send to group ${groupId}: ${err.message}`)
            return false
        }
    }

    getTotalMembers(groups) {
        return groups.reduce((total, group) => total + group.members, 0)
    }
}

// ============================================================================
// PROMOTION ENGINE - HANDLES PROMOTION LOGIC
// ============================================================================

class PromotionEngine {
    constructor(sock, groupManager, db, rateLimiter) {
        this.sock = sock
        this.groupManager = groupManager
        this.db = db
        this.rateLimiter = rateLimiter
        this.promotionQueue = []
        this.isPromoting = false
    }

    async executePromotion(message, attachment, count) {
        if (this.isPromoting) {
            return { success: false, error: "Promotion already in progress" }
        }

        this.isPromoting = true

        try {
            const groups = await this.groupManager.getAllGroups()
            
            if (groups.length === 0) {
                return { success: false, error: "No groups found", sent: 0, failed: 0 }
            }

            let sent = 0
            let failed = 0

            logger.promotion(`Starting promotion to ${count} groups (${groups.length} available)`)

            for (let i = 0; i < Math.min(count, groups.length); i++) {
                const group = groups[i]

                try {
                    let finalMessage = MessageFormatter.paidPromote(message)
                    
                    if (attachment.toLowerCase() !== "n/a") {
                        finalMessage += `\n\nAttachment: ${attachment}`
                    }

                    const success = await this.groupManager.sendToGroup(group.id, finalMessage)
                    
                    if (success) {
                        sent++
                        logger.promotion(`Sent to: ${group.name} (${group.members} members)`)
                    } else {
                        failed++
                    }

                    await this.rateLimiter.wait()

                } catch (err) {
                    failed++
                    logger.error(`Promotion error in ${group.name}: ${err.message}`)
                }
            }

            this.db.addPromotion(
                `${sent} groups`,
                message.substring(0, 50),
                count,
                sent
            )

            logger.promotion(`Completed: ${sent} sent, ${failed} failed`)

            return { success: true, sent, failed }

        } catch (err) {
            logger.error("Promotion execution error: " + err.message)
            return { success: false, error: err.message, sent: 0, failed: 0 }

        } finally {
            this.isPromoting = false
        }
    }
}

// ============================================================================
// COMMAND HANDLER - PROCESSES BOT COMMANDS
// ============================================================================

class CommandHandler {
    constructor(sock, groupManager, promotionEngine, db) {
        this.sock = sock
        this.groupManager = groupManager
        this.promotionEngine = promotionEngine
        this.db = db
    }

    async handleMenu(sender) {
        try {
            const menu = MessageFormatter.menu()
            await this.sock.sendMessage(sender, { text: menu })
            this.db.incrementCommandCount()
            logger.command("Sent .menu response")
        } catch (err) {
            logger.error("Menu command error: " + err.message)
        }
    }

    async handleGroups(sender) {
        try {
            logger.info("Fetching groups...")
            const groups = await this.groupManager.getAllGroups()
            const totalMembers = this.groupManager.getTotalMembers(groups)
            const groupsList = MessageFormatter.groupsList(groups, totalMembers)
            
            await this.sock.sendMessage(sender, { text: groupsList })
            this.db.incrementCommandCount()
            logger.group(`Sent ${groups.length} groups to user`)
        } catch (err) {
            logger.error("Groups command error: " + err.message)
            await this.sock.sendMessage(sender, { 
                text: MessageFormatter.error("Failed to fetch groups") 
            })
        }
    }

    async handlePromote(sender, args) {
        try {
            const validation = Validator.validatePromoteArgs(args)
            
            if (!validation.valid) {
                await this.sock.sendMessage(sender, { 
                    text: MessageFormatter.error(validation.error) 
                })
                return
            }

            const count = parseInt(args[args.length - 1])
            const attachment = args[args.length - 2]
            const message = args.slice(0, -2).join(" ")

            await this.sock.sendMessage(sender, { 
                text: MessageFormatter.promoteStarted(count) 
            })

            logger.command(`Promote started: "${message}" to ${count} groups`)

            const result = await this.promotionEngine.executePromotion(message, attachment, count)

            if (result.success) {
                await this.sock.sendMessage(sender, { 
                    text: MessageFormatter.promoteCompleted(result.sent, result.failed) 
                })
            } else {
                await this.sock.sendMessage(sender, { 
                    text: MessageFormatter.error(result.error) 
                })
            }

            this.db.incrementCommandCount()

        } catch (err) {
            logger.error("Promote command error: " + err.message)
            await this.sock.sendMessage(sender, { 
                text: MessageFormatter.error("Promotion failed") 
            })
        }
    }

    async handle(sender, text) {
        const parsed = Validator.parseCommand(text)
        
        if (!parsed) return

        db.incrementMessageCount()

        switch (parsed.command) {
            case "menu":
                await this.handleMenu(sender)
                break
            case "groups":
                await this.handleGroups(sender)
                break
            case "promote":
                await this.handlePromote(sender, parsed.args)
                break
            default:
                await this.sock.sendMessage(sender, { 
                    text: "Unknown command. Use .menu to see available commands" 
                })
        }
    }
}

// ============================================================================
// CONNECTION MANAGER - HANDLES BOT CONNECTION STATE
// ============================================================================

class ConnectionManager {
    constructor() {
        this.isConnected = false
        this.reconnectAttempts = 0
        this.maxReconnectAttempts = 5
        this.reconnectDelay = 3000
    }

    markConnected() {
        this.isConnected = true
        this.reconnectAttempts = 0
        logger.success("Bot connected successfully")
    }

    markDisconnected() {
        this.isConnected = false
        logger.error("Bot disconnected")
    }

    canReconnect() {
        return this.reconnectAttempts < this.maxReconnectAttempts
    }

    incrementReconnectAttempts() {
        this.reconnectAttempts++
    }

    getReconnectDelay() {
        return this.reconnectDelay * (this.reconnectAttempts + 1)
    }
}

const connectionManager = new ConnectionManager()

// ============================================================================
// ADVANCED BOT CLASS - MAIN BOT LOGIC
// ============================================================================

class AdvancedWhatsAppBot {
    constructor() {
        this.sock = null
        this.groupManager = null
        this.promotionEngine = null
        this.commandHandler = null
        this.connectionManager = new ConnectionManager()
    }

    async initialize() {
        try {
            logger.info("Initializing bot...")

            const { state, saveCreds } = await useMultiFileAuthState("auth")

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: new SilentLogger(),
                syncFullHistory: false,
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false
            })

            this.groupManager = new GroupManager(this.sock, db)
            this.promotionEngine = new PromotionEngine(
                this.sock,
                this.groupManager,
                db,
                rateLimiter
            )
            this.commandHandler = new CommandHandler(
                this.sock,
                this.groupManager,
                this.promotionEngine,
                db
            )

            this.sock.ev.on("creds.update", saveCreds)
            this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update))
            this.sock.ev.on("messages.upsert", ({ messages }) => this.handleMessages(messages))

            logger.success("Bot initialized successfully")

        } catch (err) {
            logger.error("Initialization error: " + err.message)
            throw err
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log("\n")
            qrcode.generate(qr, { small: true })
            console.log("\n")
        }

        if (connection === "open") {
            this.connectionManager.markConnected()
        }

        if (connection === "close") {
            this.connectionManager.markDisconnected()

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut

            if (shouldReconnect && this.connectionManager.canReconnect()) {
                this.connectionManager.incrementReconnectAttempts()
                const delay = this.connectionManager.getReconnectDelay()
                logger.info(`Reconnecting in ${delay}ms (attempt ${this.connectionManager.reconnectAttempts})...`)
                setTimeout(() => this.initialize(), delay)
            }
        }
    }

    async handleMessages(messages) {
        for (const msg of messages) {
            try {
                if (!msg.message) continue
                if (msg.key.fromMe) continue

                const text = msg.message.conversation ||
                             msg.message.extendedTextMessage?.text ||
                             ""

                if (!text || !Validator.isCommand(text)) continue

                const sender = msg.key.remoteJid
                const sanitizedText = Validator.sanitize(text)

                logger.info(`Command received: ${sanitizedText}`)

                await this.commandHandler.handle(sender, sanitizedText)

            } catch (err) {
                logger.error("Message handling error: " + err.message)
            }
        }
    }

    start() {
        this.initialize()
    }
}

// ============================================================================
// START BOT
// ============================================================================

const bot = new AdvancedWhatsAppBot()
bot.start()

// ============================================================================
// UTILITY FUNCTIONS - STATISTICS AND MONITORING
// ============================================================================

function printStats() {
    const stats = db.getStats()
    console.log("\n")
    console.log("-- BOT STATISTICS --")
    console.log(`Total Messages: ${stats.totalMessages}`)
    console.log(`Total Commands: ${stats.totalCommands}`)
    console.log(`Total Promotions: ${stats.totalPromotions}`)
    console.log(`Total Groups Promoted: ${stats.totalGroupsPromoted}`)
    console.log(`Started: ${new Date(stats.startTime).toLocaleString()}`)
    console.log("\n")
}

function printGroups() {
    const groups = db.getAllGroups()
    console.log(`\nTotal Groups in Database: ${groups.length}`)
}

setInterval(printStats, 300000)

// ============================================================================
// END OF BOT CODE
// ============================================================================