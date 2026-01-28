// ============================================================================
// SECTION 1: CONFIGURATION AND GLOBAL HELPERS - START
// ============================================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ProgressBar = require('progress');
const xml2js = require('xml2js');

try {
    require('dotenv').config();
} catch (error) {
    // Optional dependency; ignore if not installed.
}

const IS_RENDER = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const USE_PROXY = process.env.USE_PROXY
    ? process.env.USE_PROXY.toLowerCase() === 'true'
    : !IS_RENDER;

// BRIGHT DATA PROXY CONFIGURATION (optional)
const PROXY_CONFIG = USE_PROXY ? {
    protocol: process.env.PROXY_PROTOCOL || 'http',
    host: process.env.PROXY_HOST || 'brd.superproxy.io',
    port: Number(process.env.PROXY_PORT || 33335),
    auth: {
        username: process.env.PROXY_USERNAME || 'brd-customer-hl_b26eb287-zone-resproxy01',
        password: process.env.PROXY_PASSWORD || 'o7l63g2v8qnh'
    }
} : null;

// Add HTTPS agent configuration for proxy
const https = require('https');
const http = require('http');

// Better HTTPS/HTTP agents with connection pooling
const HTTPS_AGENT = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,      // Increase concurrent connections
    maxFreeSockets: 10,  // Keep connections alive
    timeout: 60000
});

const HTTP_AGENT = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000
});


// FEATURE FLAGS
const FEATURE_FLAGS = {
    SHOW_LOWEST_PRICED: true,
    LOWEST_PRICED_COUNT: 10,
    LOWEST_PRICED_THRESHOLD: 0.01,
    FREE_ITEMS_THRESHOLD: 0.01,
    ENABLE_PERFORMANCE_MODE: true,
    CONSERVATIVE_RATE_LIMITS: false, // Disable for speed
    ENABLE_SAFE_MODE: false,
    ENABLE_VARIANT_ENUMERATION: false,
    ENABLE_SITEMAP_PARSING: false, // Disable for proxy performance
    ENABLE_SEARCH_EXPLOITATION: true,
    ENABLE_SITE_TRACKING: true,
    MAX_PRODUCT_PAGES_STANDARD: 100, // Reduced
    MAX_PRODUCT_PAGES_SORTED: 25,   // Reduced
    MAX_COLLECTION_PAGES: 25,       // Reduced
    CONSECUTIVE_EMPTY_PRODUCT_PAGES: 3, // Reduced
    CONSECUTIVE_EMPTY_COLLECTION_PAGES: 2 // Reduced
};

const AXIOS_TIMEOUT = 8000; // Reduced from 15000

let rl = null;
if (process.stdin.isTTY) {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

let globalSettings = {
    outputFolder: null,
    maxConcurrent: FEATURE_FLAGS.ENABLE_SAFE_MODE ? 15 : (FEATURE_FLAGS.ENABLE_PERFORMANCE_MODE ? 35 : 25), // Reduced for proxies
    delay: FEATURE_FLAGS.ENABLE_SAFE_MODE ? 50 : (FEATURE_FLAGS.ENABLE_PERFORMANCE_MODE ? 15 : 30), // More aggressive
    enableProgressBars: true,
    enableCheckpoints: true,
    enableSitemapParsing: FEATURE_FLAGS.ENABLE_SITEMAP_PARSING,
    enableVariantAnalysis: true,
    enableNotifications: true,
    autoVariantEnumeration: FEATURE_FLAGS.ENABLE_VARIANT_ENUMERATION,
        enhancedThoroughness: false, // Disable for speed
    adaptiveDelays: true,
    saveResultsBeforeEnumeration: true,
    conservativeEstimates: true,
    enableEnumerationQueue: false, // Disable for speed
    batchSize: FEATURE_FLAGS.ENABLE_SAFE_MODE ? 2000 : (FEATURE_FLAGS.ENABLE_PERFORMANCE_MODE ? 6000 : 4000), // Increased
    cacheSize: 15000, // Increased cache
    memoryOptimized: true,
    lowestPricedCount: FEATURE_FLAGS.LOWEST_PRICED_COUNT
};

let enumerationQueue = [];
let enumerationHistory = [];
let productCache = new Map();
let variantCache = new Map();

const SCAN_HISTORY_FILE = path.join(__dirname, 'scan-history.csv');
const SCAN_SUMMARY_FILE = path.join(__dirname, 'scan-summary.csv');

// ==================== FILE AND STATE MANAGEMENT HELPERS ====================

function initializeTrackingFiles() {
    if (!FEATURE_FLAGS.ENABLE_SITE_TRACKING) return;
    
    try {
        if (!fs.existsSync(SCAN_HISTORY_FILE)) {
            const historyHeader = 'Domain,Timestamp,Free Items Count,No Free Items Count,Total Scans,Last Scan Date\n';
            fs.writeFileSync(SCAN_HISTORY_FILE, historyHeader);
        }
        
        if (!fs.existsSync(SCAN_SUMMARY_FILE)) {
            const summaryHeader = 'Domain,Free Items Found,No Free Items Found,Total Scans,Success Rate,Last Scan\n';
            fs.writeFileSync(SCAN_SUMMARY_FILE, summaryHeader);
        }
    } catch (error) {
        console.error(`⚠️ Error initializing tracking files: ${error.message}`);
    }
}

function updateTrackingFiles(domain, hasFreeItems, freeItemsCount = 0) {
    if (!FEATURE_FLAGS.ENABLE_SITE_TRACKING) return;
    
    const timestamp = new Date().toISOString();
    let trackingData = {};
    
    try {
        if (fs.existsSync(SCAN_HISTORY_FILE)) {
            const content = fs.readFileSync(SCAN_HISTORY_FILE, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            for (let i = 1; i < lines.length; i++) {
                const [existingDomain, , freeItems, noFreeItems, totalScans] = lines[i].split(',');
                if (existingDomain === domain) {
                    trackingData = {
                        freeItemsCount: parseInt(freeItems) || 0,
                        noFreeItemsCount: parseInt(noFreeItems) || 0,
                        totalScans: parseInt(totalScans) || 0
                    };
                    break;
                }
            }
        }
    } catch (error) {
        console.error(`⚠️ Error reading SCAN_HISTORY_FILE: ${error.message}`);
    }
    
    if (hasFreeItems) {
        trackingData.freeItemsCount = (trackingData.freeItemsCount || 0) + 1;
    } else {
        trackingData.noFreeItemsCount = (trackingData.noFreeItemsCount || 0) + 1;
    }
    
    trackingData.totalScans = (trackingData.totalScans || 0) + 1;
    updateHistoryFile(domain, trackingData, timestamp);
    updateSummaryFile(domain, trackingData, timestamp);
}

function updateHistoryFile(domain, data, timestamp) {
    const lines = [];
    let found = false;
    
    try {
        if (fs.existsSync(SCAN_HISTORY_FILE)) {
            const content = fs.readFileSync(SCAN_HISTORY_FILE, 'utf8');
            const existingLines = content.split('\n');
            for (const line of existingLines) {
                if (line.trim() === '') continue;
                const parts = line.split(',');
                if (parts[0] === domain) {
                    lines.push(`${domain},${timestamp},${data.freeItemsCount},${data.noFreeItemsCount},${data.totalScans},${timestamp}`);
                    found = true;
                } else {
                    lines.push(line);
                }
            }
        }
        
        if (!found) {
            if (lines.length === 0) {
                lines.push('Domain,Timestamp,Free Items Count,No Free Items Count,Total Scans,Last Scan Date');
            }
            lines.push(`${domain},${timestamp},${data.freeItemsCount},${data.noFreeItemsCount},${data.totalScans},${timestamp}`);
        }
        
        fs.writeFileSync(SCAN_HISTORY_FILE, lines.join('\n') + '\n');
    } catch (error) {
        console.error(`⚠️ Error updating history file: ${error.message}`);
    }
}

function updateSummaryFile(domain, data, timestamp) {
    const lines = [];
    let found = false;
    
    try {
        if (fs.existsSync(SCAN_SUMMARY_FILE)) {
            const content = fs.readFileSync(SCAN_SUMMARY_FILE, 'utf8');
            const existingLines = content.split('\n');
            for (const line of existingLines) {
                if (line.trim() === '') continue;
                const parts = line.split(',');
                if (parts[0] === domain) {
                    const successRate = ((data.freeItemsCount / data.totalScans) * 100).toFixed(1);
                    lines.push(`${domain},${data.freeItemsCount},${data.noFreeItemsCount},${data.totalScans},${successRate}%,${timestamp}`);
                    found = true;
                } else {
                    lines.push(line);
                }
            }
        }
        
        if (!found) {
            if (lines.length === 0) {
                lines.push('Domain,Free Items Found,No Free Items Found,Total Scans,Success Rate,Last Scan');
            }
            const successRate = ((data.freeItemsCount / data.totalScans) * 100).toFixed(1);
            lines.push(`${domain},${data.freeItemsCount},${data.noFreeItemsCount},${data.totalScans},${successRate}%,${timestamp}`);
        }
        
        fs.writeFileSync(SCAN_SUMMARY_FILE, lines.join('\n') + '\n');
    } catch (error) {
        console.error(`⚠️ Error updating summary file: ${error.message}`);
    }
}

function loadSettings() {
    const settingsFile = path.join(__dirname, 'scanner-settings.json');
    if (fs.existsSync(settingsFile)) {
        try {
            const data = fs.readFileSync(settingsFile, 'utf8');
            const loadedSettings = JSON.parse(data);
            globalSettings = { ...globalSettings, ...loadedSettings };
            if (loadedSettings.lowestPricedCount) {
                FEATURE_FLAGS.LOWEST_PRICED_COUNT = loadedSettings.lowestPricedCount;
                globalSettings.lowestPricedCount = loadedSettings.lowestPricedCount;
            }
            console.log('📋 Settings loaded successfully');
        } catch (error) {
            console.log(`⚠️ Error loading settings: ${error.message}, using defaults`);
        }
    }
    
    const queueFile = path.join(__dirname, 'enumeration-queue.json');
    if (fs.existsSync(queueFile)) {
        try {
            const data = fs.readFileSync(queueFile, 'utf8');
            const queueData = JSON.parse(data);
            enumerationQueue = queueData.queue || [];
            enumerationHistory = queueData.history || [];
            console.log(`📋 Enumeration queue loaded: ${enumerationQueue.length} pending`);
        } catch (error) {
            console.log(`⚠️ Error loading enumeration queue: ${error.message}`);
        }
    }
    
    initializeTrackingFiles();
}

function saveSettings() {
    const settingsFile = path.join(__dirname, 'scanner-settings.json');
    try {
        fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
        console.log('💾 Settings saved successfully');
    } catch (error) {
        console.log(`⚠️ Error saving settings: ${error.message}`);
    }
}

// ==================== UTILITY FUNCTIONS ====================

function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

function cleanupMemory() {
    if (productCache.size > globalSettings.cacheSize) {
        const entries = Array.from(productCache.entries());
        const keepEntries = entries.slice(-Math.floor(globalSettings.cacheSize * 0.7));
        productCache.clear();
        keepEntries.forEach(([key, value]) => productCache.set(key, value));
    }
    
    if (variantCache.size > globalSettings.cacheSize) {
        const entries = Array.from(variantCache.entries());
        const keepEntries = entries.slice(-Math.floor(globalSettings.cacheSize * 0.7));
        variantCache.clear();
        keepEntries.forEach(([key, value]) => variantCache.set(key, value));
    }
    
    if (global.gc) global.gc();
}

setInterval(cleanupMemory, 60000);

function cleanDomainInput(input) {
    if (!input || typeof input !== 'string') return null;
    
    try {
        let url;
        if (!input.startsWith('http://') && !input.startsWith('https://')) {
            url = new URL(`https://${input}`);
        } else {
            url = new URL(input);
        }
        
        let cleaned = url.hostname;
        cleaned = cleaned.replace(/^www\./, '');
        if (cleaned && cleaned.includes('.') && cleaned.length > 3) return cleaned.toLowerCase();
        return null;
    } catch (error) {
        return null;
    }
}

function isUrl(input) {
    try {
        new URL(input);
        return true;
    } catch {
        return false;
    }
}

function ensureOutputDirectory() {
    const outputDir = globalSettings.outputFolder || path.join(__dirname, 'scanner-results');
    try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
        console.error(`⚠️ Error ensuring output directory: ${error.message}`);
        process.exit(1);
    }
    return outputDir;
}

function estimateEnumerationDuration(scanner) {
    const knownVariants = scanner.processedVariantIds.size;
    if (knownVariants < 2) return { message: 'Cannot estimate duration with fewer than 2 known variants' };
    
    const variantIds = Array.from(scanner.processedVariantIds).map(id => parseInt(id)).sort((a, b) => a - b);
    const min = variantIds[0];
    const max = variantIds[variantIds.length - 1];
    const totalRange = max - min;
    
    if (globalSettings.conservativeEstimates) {
        const estimatedMinutes = Math.ceil(totalRange / 1000);
        return { message: `Estimated duration: ${estimatedMinutes}-${estimatedMinutes * 3} minutes (conservative estimate)` };
    } else {
        const estimatedMinutes = Math.ceil(totalRange / 2000);
        return { message: `Estimated duration: ${estimatedMinutes}-${estimatedMinutes * 2} minutes` };
    }
}

function setupEnumerationControls(scanner) {
    if (!process.stdin.isTTY) return () => {};
    
    const stdin = process.stdin;
    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const keyHandler = (key) => {
        switch (key.toLowerCase()) {
            case 's': console.log('\n⏭️ Skipping enumeration...'); scanner.skipEnumeration = true; break;
            case 'p': scanner.isPaused = !scanner.isPaused; console.log(`\n${scanner.isPaused ? '⏸️ Paused' : '▶️ Resumed'} enumeration`); break;
            case 'q': console.log('\n🛑 Stopping enumeration...'); scanner.shouldStop = true; break;
            case '\u0003': // Ctrl+C
                console.log('\n👋 Exiting...'); scanner.saveCheckpoint(); scanner.saveEnumerationCheckpoint(); process.exit(0);
        }
    };
    
    stdin.on('data', keyHandler);
    
    return () => {
        stdin.removeListener('data', keyHandler);
        stdin.setRawMode(false);
        rl.resume();
    };
}

function showResultsSummary(scanner) {
    console.log('\n' + '='.repeat(60));
    console.log('🎉 SCAN COMPLETE - RESULTS SUMMARY');
    console.log('='.repeat(60));
    
    if (FEATURE_FLAGS.SHOW_LOWEST_PRICED && scanner.lowestPricedItems.length > 0) {
        console.log(`🏷️ LOWEST PRICED ITEMS: ${scanner.lowestPricedItems.length}`);
        scanner.lowestPricedItems.slice(0, 3).forEach((item, i) =>
            console.log(` ${i + 1}. ${item.title} - $${item.price.toFixed(2)}`));
        if (scanner.lowestPricedItems.length > 3)
            console.log(` ... and ${scanner.lowestPricedItems.length - 3} more`);
        console.log('');
    }
    
    if (scanner.freeItems.length > 0) {
        console.log(`🎁 FREE ITEMS FOUND: ${scanner.freeItems.length}`);
        scanner.freeItems.slice(0, 3).forEach((item, i) =>
            console.log(` ${i + 1}. ${item.title} - $${item.price.toFixed(2)}`));
        if (scanner.freeItems.length > 3)
            console.log(` ... and ${scanner.freeItems.length - 3} more`);
        console.log('');
    }
    
    console.log(`📊 Total variants processed: ${scanner.stats.variantsProcessed}`);
    console.log(`📦 Products found: ${scanner.stats.productsFound}`);
    console.log(`🗂️ Collections found: ${scanner.stats.collectionsFound}`);
    const duration = (Date.now() - scanner.stats.startTime) / 1000;
    console.log(`⏱️ Total time: ${duration.toFixed(1)} seconds`);
    console.log(`📁 Results saved to: ${scanner.outputFile}`);
    console.log(`📊 CSV data saved to: ${scanner.csvFile}`);
    console.log('='.repeat(60));
    console.log('🔄 Returning to main menu...\n');
}

// ============================================================================
// SECTION 1: CONFIGURATION AND CORE SETUP - END
// ============================================================================
// ============================================================================
// SECTION 2: ENHANCED SHOPIFY SCANNER CLASS DEFINITION - START
// ============================================================================

class EnhancedShopifyScanner {
    constructor(baseUrl, options = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.domain = new URL(baseUrl).hostname;
        this.originalDomain = options.originalDomain || this.domain;
        this.skipVariantEnumeration = options.skipVariantEnumeration || !FEATURE_FLAGS.ENABLE_VARIANT_ENUMERATION;
        this.maxVariantsBeforeSkip = options.maxVariantsBeforeSkip || 500;
        this.enableProgressBars = globalSettings.enableProgressBars;
        this.enableCheckpoints = globalSettings.enableCheckpoints;
        this.enableSitemapParsing = FEATURE_FLAGS.ENABLE_SITEMAP_PARSING;
        this.enableVariantAnalysis = globalSettings.enableVariantAnalysis;
        this.enableNotifications = globalSettings.enableNotifications;
        this.skipEnumeration = false;
        this.enumerationPaused = false;
        this.maxConcurrent = globalSettings.maxConcurrent;
        this.activeRequests = 0;
        this.delay = globalSettings.delay;
        this.batchSize = globalSettings.batchSize;
        this.adaptiveDelay = globalSettings.delay;
        this.requestSuccessRate = 1.0;
        this.lastRateLimitTime = 0;
        this.processedVariantIds = new Set();
        this.processedProductHandles = new Set();
        this.processedCollectionHandles = new Set();
        this.sitemapUrls = new Set();
        this.isPaused = false;
        this.shouldStop = false;
        this.lowestPricedItems = [];
        this.freeItems = [];
        
        this.variantAnalysis = {
            variantCombinations: new Map(),
            pricePatterns: new Map(),
            inventoryData: new Map(),
            discontinuedProducts: new Set()
        };
        
        this.stats = {
            variantsProcessed: 0,
            productsFound: 0,
            collectionsFound: 0,
            freeItemsFound: 0,
            lowestPricedFound: false,
            totalRequests: 0,
            sitemapUrlsFound: 0,
            startTime: Date.now(),
            lastCheckpoint: Date.now(),
            skippedVariantEnumeration: false,
            currentPhase: 'Initializing',
            discontinuedProductsFound: 0,
            variantCombinationsAnalyzed: 0,
            enumerationStartTime: null,
            enumerationEndTime: null
        };
        
        const outputDir = ensureOutputDirectory();
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
        
        // Store base filename components for later modification
        this.baseFilename = `${this.originalDomain}_${timestamp}`;
        this.outputDir = outputDir;
        this.freeFilenamesUpdated = false;
        
        // Initialize with temporary names (will be updated when free items are found)
        this.outputFile = path.join(outputDir, `${this.baseFilename}.txt`);
        this.csvFile = path.join(outputDir, `${this.baseFilename}.csv`);
        this.checkpointFile = path.join(outputDir, `${this.baseFilename}_checkpoint.json`);
        this.enumerationCheckpointFile = path.join(outputDir, `${this.baseFilename}_enumeration_checkpoint.json`);
        
        this.initializeOutputFiles();
        this.setupGracefulShutdown();
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.progressBars = {};
    }

    // === Utility methods
    setupGracefulShutdown() {
        if (process.stdin.isTTY) {
            process.on('SIGINT', () => {
                console.log('\n⏸️ Scan paused. Press Ctrl+C again to exit, or wait to resume...');
                if (this.isPaused) {
                    console.log('👋 Exiting scanner...');
                    this.saveCheckpoint();
                    this.saveEnumerationCheckpoint();
                    process.exit(0);
                } else {
                    this.isPaused = true;
                    setTimeout(() => {
                        if (this.isPaused) {
                            console.log('▶️ Resuming scan...');
                            this.isPaused = false;
                        }
                    }, 3000);
                }
            });
        }
    }

    initializeOutputFiles() {
        fs.writeFileSync(this.outputFile, `Enhanced Shopify Scan for ${this.originalDomain}\n`);
        fs.appendFileSync(this.outputFile, `Working URL: ${this.baseUrl}\n`);
        fs.appendFileSync(this.outputFile, `Started: ${new Date().toISOString()}\n\n`);
        fs.writeFileSync(this.csvFile, 'Title,Variant,Price,Available,Cart URL,Product URL,Source,Found At\n');
    }

    showNotification(message) {
        if (this.enableNotifications) {
            console.log(`🔔 NOTIFICATION: ${message}`);
        }
    }

    // === NEW METHOD: Update filenames when free items are found ===
    updateFilenamesForFreeItems() {
        if (this.freeItems.length > 0 && !this.freeFilenamesUpdated) {
            const oldOutputFile = this.outputFile;
            const oldCsvFile = this.csvFile;
            
            // Update filenames to include 'FREE_' prefix
            this.baseFilename = `FREE_${this.originalDomain}_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`;
            this.outputFile = path.join(this.outputDir, `${this.baseFilename}.txt`);
            this.csvFile = path.join(this.outputDir, `${this.baseFilename}.csv`);
            this.checkpointFile = path.join(this.outputDir, `${this.baseFilename}_checkpoint.json`);
            
            // Rename existing files if they exist
            try {
                if (fs.existsSync(oldOutputFile)) {
                    fs.renameSync(oldOutputFile, this.outputFile);
                }
                if (fs.existsSync(oldCsvFile)) {
                    fs.renameSync(oldCsvFile, this.csvFile);
                }
                console.log(`📁 Updated filenames to include 'FREE_' prefix`);
                this.freeFilenamesUpdated = true;
            } catch (error) {
                console.log(`⚠️ Could not rename files: ${error.message}`);
            }
        }
    }

    // ========== Progress bars and request queue helpers ==========
    createProgressBar(name, total, format) {
        if (!globalSettings.enableProgressBars) return null;
        
        const bar = new ProgressBar(format || `${name} [:bar] :current/:total :percent :etas`, {
            complete: '█',
            incomplete: '░',
            width: 30,
            total: total || 100,
            renderThrottle: 100
        });
        this.progressBars[name] = bar;
        return bar;
    }

    updateProgress(name, increment = 1) {
        if (this.progressBars && this.progressBars[name] && !this.progressBars[name].complete) {
            this.progressBars[name].tick(increment);
        }
    }

    cleanupProgressBars() {
        if (!this.progressBars) return;
        Object.keys(this.progressBars).forEach(name => {
            if (this.progressBars[name] && this.progressBars[name].complete) {
                delete this.progressBars[name];
            }
        });
    }

    saveCheckpoint() {
        if (!globalSettings.enableCheckpoints) return;
        
        const checkpoint = {
            stats: this.stats,
            processedVariantIds: Array.from(this.processedVariantIds),
            processedProductHandles: Array.from(this.processedProductHandles),
            processedCollectionHandles: Array.from(this.processedCollectionHandles),
            sitemapUrls: Array.from(this.sitemapUrls),
            lowestPricedItems: this.lowestPricedItems,
            freeItems: this.freeItems,
            variantAnalysis: {
                variantCombinations: Array.from(this.variantAnalysis.variantCombinations.entries()),
                pricePatterns: Array.from(this.variantAnalysis.pricePatterns.entries()),
                inventoryData: Array.from(this.variantAnalysis.inventoryData.entries()),
                discontinuedProducts: Array.from(this.variantAnalysis.discontinuedProducts)
            },
            timestamp: new Date().toISOString()
        };
        
        try {
            fs.writeFileSync(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
            console.log(`💾 Checkpoint saved: ${this.stats.variantsProcessed} variants processed`);
        } catch (error) {
            console.log('⚠️ Error saving checkpoint:', error.message);
        }
    }

    saveEnumerationCheckpoint() {
        if (!globalSettings.enableCheckpoints) return;
        
        const enumerationCheckpoint = {
            stats: this.stats,
            processedVariantIds: Array.from(this.processedVariantIds),
            lowestPricedItems: this.lowestPricedItems,
            freeItems: this.freeItems,
            enumerationState: {
                phase: 'enumeration',
                lastProcessedId: this.stats.lastProcessedEnumerationId || 0,
                completedRanges: this.stats.completedEnumerationRanges || []
            },
            timestamp: new Date().toISOString()
        };
        
        try {
            fs.writeFileSync(this.enumerationCheckpointFile, JSON.stringify(enumerationCheckpoint, null, 2));
            console.log(`💾 Enumeration checkpoint saved`);
        } catch (error) {
            console.log('⚠️ Error saving enumeration checkpoint:', error.message);
        }
    }

    loadCheckpoint() {
        if (!globalSettings.enableCheckpoints || !fs.existsSync(this.checkpointFile)) return false;
        
        try {
            const checkpoint = JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8'));
            this.stats = { ...this.stats, ...checkpoint.stats };
            this.processedVariantIds = new Set(checkpoint.processedVariantIds);
            this.processedProductHandles = new Set(checkpoint.processedProductHandles);
            this.processedCollectionHandles = new Set(checkpoint.processedCollectionHandles);
            this.sitemapUrls = new Set(checkpoint.sitemapUrls);
            this.lowestPricedItems = checkpoint.lowestPricedItems || [];
            this.freeItems = checkpoint.freeItems || [];
            
            if (checkpoint.variantAnalysis) {
                this.variantAnalysis.variantCombinations = new Map(checkpoint.variantAnalysis.variantCombinations);
                this.variantAnalysis.pricePatterns = new Map(checkpoint.variantAnalysis.pricePatterns);
                this.variantAnalysis.inventoryData = new Map(checkpoint.variantAnalysis.inventoryData);
                this.variantAnalysis.discontinuedProducts = new Set(checkpoint.variantAnalysis.discontinuedProducts);
            }
            
            console.log(`📂 Checkpoint loaded: ${this.stats.variantsProcessed} variants previously processed`);
            return true;
        } catch (error) {
            console.log('⚠️ Error loading checkpoint:', error.message);
            return false;
        }
    }

    updateAdaptiveDelay(success) {
        if (success) {
            this.requestSuccessRate = this.requestSuccessRate * 0.95 + 0.05;
            if (this.requestSuccessRate > 0.9 && this.adaptiveDelay > globalSettings.delay) {
                this.adaptiveDelay = Math.max(globalSettings.delay, this.adaptiveDelay * 0.95);
            }
        } else {
            this.requestSuccessRate = this.requestSuccessRate * 0.95;
            if (this.requestSuccessRate < 0.7) {
                this.adaptiveDelay = Math.min(5000, this.adaptiveDelay * 1.2);
            }
        }
    }

    makeRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ url, options, resolve, reject });
            this.processRequestQueue();
        });
    }

    async processRequestQueue() {
        if (this.isProcessingQueue || this.isPaused) return;
        this.isProcessingQueue = true;
        
        const maxConcurrent = FEATURE_FLAGS.ENABLE_SAFE_MODE ? Math.floor(this.maxConcurrent * 0.5) : this.maxConcurrent;
        
        while (this.requestQueue.length > 0 && this.activeRequests < maxConcurrent && !this.isPaused) {
            const { url, options, resolve, reject } = this.requestQueue.shift();
            this.executeRequest(url, options, resolve, reject);
        }
        
        this.isProcessingQueue = false;
    }

    async executeRequest(url, options, resolve, reject) {
    this.activeRequests++;
    this.stats.totalRequests++;
    
    try {
        const isHttps = url.startsWith('https');
        const response = await axios.get(url, {
            timeout: 8000, // Reduced further for proxy timeouts
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive',
                'Accept-Encoding': 'gzip, deflate, br', // Enable compression
                'Cache-Control': 'no-cache',
                ...options.headers
            },
            proxy: PROXY_CONFIG || false,
            httpsAgent: isHttps ? HTTPS_AGENT : null,
            httpAgent: !isHttps ? HTTP_AGENT : null,
            maxRedirects: 2, // Reduced from 3
            decompress: true, // Auto-decompress responses
            ...options
        });
        
        this.updateAdaptiveDelay(true);
        resolve(response.data);
    } catch (error) {
        // Enhanced error handling for proxy issues
        this.updateAdaptiveDelay(false);
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            console.log(`⚠️ Proxy timeout for ${url.split('/').pop()}`);
            resolve(null); // Don't retry timeouts
        } else if (error.response?.status === 429) {
            this.lastRateLimitTime = Date.now();
            this.adaptiveDelay = Math.min(5000, this.adaptiveDelay * 1.5); // Reduced from 2x
            setTimeout(() => {
                this.requestQueue.unshift({ url, options, resolve, reject });
                this.processRequestQueue();
            }, this.adaptiveDelay);
        } else {
            resolve(null);
        }
    } finally {
        this.activeRequests--;
        const delay = FEATURE_FLAGS.CONSERVATIVE_RATE_LIMITS 
            ? Math.max(this.adaptiveDelay, 50) // Reduced from 100
            : this.adaptiveDelay;
        setTimeout(() => this.processRequestQueue(), delay);
    }
}

// ============================================================================
// SECTION 2: - END
// ============================================================================
// ============================================================================
// SECTION 3: SCANNING METHODS - START
// ============================================================================

    // ------------------ PRODUCT SCANNING ------------------
    async scanAllProducts() {
        console.log('📦 Scanning ALL products...');
        this.stats.currentPhase = 'Scanning Products';
        const productBar = this.createProgressBar('Products', 1000);
        
        await Promise.all([
            this.scanProductsStandard(productBar),
            this.scanProductsSorted(productBar)
        ]);
        
        this.cleanupProgressBars();
        console.log(`📦 Product discovery complete: ${this.stats.productsFound} products found`);
    }

    async scanProductsStandard(progressBar) {
        let page = 1, consecutiveEmpty = 0;
        
        while (consecutiveEmpty < FEATURE_FLAGS.CONSECUTIVE_EMPTY_PRODUCT_PAGES && 
               page < FEATURE_FLAGS.MAX_PRODUCT_PAGES_STANDARD && 
               !this.shouldStop) {
            
            if (this.isPaused) { 
                await new Promise(resolve => setTimeout(resolve, 1000)); 
                continue; 
            }
            
            console.log(`📄 Scanning products page ${page}...`);
            const url = `${this.baseUrl}/products.json?limit=250&page=${page}`;
            const data = await this.makeRequest(url);
            
            if (!data || !data.products || data.products.length === 0) {
                consecutiveEmpty++;
                page++;
                continue;
            }
            
            let newProductsThisPage = 0;
            for (const product of data.products) {
                if (!this.processedProductHandles.has(product.handle)) {
                    this.processedProductHandles.add(product.handle);
                    this.stats.productsFound++;
                    newProductsThisPage++;
                    productCache.set(product.handle, product);
                    
                    for (const variant of product.variants || []) {
                        this.processVariantImmediately(variant, product, `Products Page ${page}`);
                    }
                }
            }
            
            consecutiveEmpty = (newProductsThisPage === 0) ? consecutiveEmpty + 1 : 0;
            this.updateProgress('Products', newProductsThisPage);
            page++;
            
            if (page % 25 === 0) cleanupMemory(); // Reduced frequency
        }
    }

    async scanProductsSorted(progressBar) {
        const sortMethods = ['price:asc', 'created_at:desc', 'updated_at:desc'];
        
        for (const sortMethod of sortMethods) {
            if (this.shouldStop) break;
            
            console.log(`🔄 Scanning with sort: ${sortMethod}`);
            let page = 1, consecutiveEmpty = 0;
            
            while (consecutiveEmpty < FEATURE_FLAGS.CONSECUTIVE_EMPTY_PRODUCT_PAGES && 
                   page < FEATURE_FLAGS.MAX_PRODUCT_PAGES_SORTED && 
                   !this.shouldStop) {
                
                if (this.isPaused) { 
                    await new Promise(resolve => setTimeout(resolve, 1000)); 
                    continue; 
                }
                
                const url = `${this.baseUrl}/products.json?limit=250&page=${page}&sort_by=${sortMethod}`;
                const data = await this.makeRequest(url);
                
                if (!data || !data.products || data.products.length === 0) {
                    consecutiveEmpty++;
                    page++;
                    continue;
                }
                
                let newProductsThisPage = 0;
                for (const product of data.products) {
                    if (!this.processedProductHandles.has(product.handle)) {
                        this.processedProductHandles.add(product.handle);
                        this.stats.productsFound++;
                        newProductsThisPage++;
                        productCache.set(product.handle, product);
                        
                        for (const variant of product.variants || []) {
                            this.processVariantImmediately(variant, product, `Sorted ${sortMethod} Page ${page}`);
                        }
                    }
                }
                
                consecutiveEmpty = (newProductsThisPage === 0) ? consecutiveEmpty + 1 : 0;
                this.updateProgress('Products', newProductsThisPage);
                page++;
            }
        }
    }

    // ------------------ COLLECTION SCANNING ------------------
    async scanAllCollections() {
        console.log('🗂️ Scanning collections...');
        this.stats.currentPhase = 'Scanning Collections';
        
        const collectionsData = await this.makeRequest(`${this.baseUrl}/collections.json`);
        if (collectionsData && collectionsData.collections) {
            for (const collection of collectionsData.collections) {
                this.processedCollectionHandles.add(collection.handle);
                this.stats.collectionsFound++;
            }
        }
        
        await this.discoverHiddenCollections();
        
        const collectionHandles = Array.from(this.processedCollectionHandles);
        const collectionBatches = [];
        for (let i = 0; i < collectionHandles.length; i += 5) {
            collectionBatches.push(collectionHandles.slice(i, i + 5));
        }
        
        for (const batch of collectionBatches) {
            if (this.shouldStop) break;
            const batchPromises = batch.map(handle => this.scanCollectionProducts(handle));
            await Promise.allSettled(batchPromises);
            cleanupMemory();
        }
        
        console.log(`🗂️ Collection scanning complete: ${this.stats.collectionsFound} collections found`);
    }

    async discoverHiddenCollections() {
        const commonCollections = [
            'all', 'sale', 'new', 'featured', 'best-sellers',
            'clearance', 'discount', 'free', 'samples', 'gifts',
            'outlet', 'special', 'promo', 'deals', 'limited',
            'test', 'hidden', 'private', 'staff', 'wholesale',
            'bundle', 'combo', 'trial', 'beta', 'exclusive',
            'member', 'vip', 'loyalty', 'rewards', 'bonus'
        ];
        
        const collectionBatches = [];
        for (let i = 0; i < commonCollections.length; i += 5) {
            collectionBatches.push(commonCollections.slice(i, i + 5));
        }
        
        for (const batch of collectionBatches) {
            if (this.shouldStop) break;
            const batchPromises = batch.map(handle => this.testCollectionExists(handle));
            const results = await Promise.allSettled(batchPromises);
            
            results.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value) {
                    const handle = batch[index];
                    this.processedCollectionHandles.add(handle);
                    this.stats.collectionsFound++;
                    console.log(`🔍 Found hidden collection: ${handle}`);
                }
            });
        }
    }

    async testCollectionExists(handle) {
        if (this.processedCollectionHandles.has(handle)) return false;
        const url = `${this.baseUrl}/collections/${handle}/products.json?limit=1`;
        const data = await this.makeRequest(url);
        return data && data.products && data.products.length > 0;
    }

    async scanCollectionProducts(handle) {
        let page = 1, consecutiveEmpty = 0;
        
        while (consecutiveEmpty < FEATURE_FLAGS.CONSECUTIVE_EMPTY_COLLECTION_PAGES && 
               page < FEATURE_FLAGS.MAX_COLLECTION_PAGES && 
               !this.shouldStop) {
            
            if (this.isPaused) { 
                await new Promise(resolve => setTimeout(resolve, 1000)); 
                continue; 
            }
            
            const url = `${this.baseUrl}/collections/${handle}/products.json?limit=250&page=${page}`;
            const data = await this.makeRequest(url);
            
            if (!data || !data.products || data.products.length === 0) {
                consecutiveEmpty++;
                page++;
                continue;
            }
            
            let newProductsThisPage = 0;
            for (const product of data.products) {
                if (!this.processedProductHandles.has(product.handle)) {
                    this.processedProductHandles.add(product.handle);
                    this.stats.productsFound++;
                    newProductsThisPage++;
                    productCache.set(product.handle, product);
                    
                    for (const variant of product.variants || []) {
                        this.processVariantImmediately(variant, product, `Collection ${handle} Page ${page}`);
                    }
                }
            }
            
            consecutiveEmpty = (newProductsThisPage === 0) ? consecutiveEmpty + 1 : 0;
            page++;
        }
    }

    // ------------------ SEARCH EXPLOITATION ------------------
    async exploitSearchEndpoints() {
        if (!FEATURE_FLAGS.ENABLE_SEARCH_EXPLOITATION) return;
        
        console.log('🔍 Exploiting search endpoints...');
        this.stats.currentPhase = 'Search Exploitation';
        
        const searchQueries = [
            '*', 'a', 'sale', 'free', 'new', 'discount',
            'price:0', '0.00', '$0', 'sample', 'gift',
            'clearance', 'outlet', 'promo', 'deal', 'special',
            'test', 'demo', 'trial', 'beta', 'preview',
            'bundle', 'combo', 'set', 'kit', 'collection',
            'limited', 'exclusive', 'member', 'vip', 'bonus'
        ];
        
        const queryBatches = [];
        for (let i = 0; i < searchQueries.length; i += 3) {
            queryBatches.push(searchQueries.slice(i, i + 3));
        }
        
        for (const batch of queryBatches) {
            if (this.shouldStop) break;
            const batchPromises = batch.map(query => this.processSearchQuery(query));
            await Promise.allSettled(batchPromises);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log('🔍 Search exploitation complete');
    }

    async processSearchQuery(query) {
        const url = `${this.baseUrl}/search.json?q=${encodeURIComponent(query)}&limit=250`;
        await this.processSearchResults(url, `Search ${query}`);
    }

    async processSearchResults(url, source) {
        const data = await this.makeRequest(url);
        if (!data) return;
        
        let products = [];
        if (data.products) {
            products = data.products;
        } else if (data.results) {
            products = data.results.filter(r => r.object_type === 'product');
        }
        
        const productBatches = [];
        for (let i = 0; i < products.length; i += 10) {
            productBatches.push(products.slice(i, i + 10));
        }
        
        for (const batch of productBatches) {
            if (this.shouldStop) break;
            const batchPromises = batch.map(product => this.processSearchProduct(product, source));
            await Promise.allSettled(batchPromises);
        }
    }

    async processSearchProduct(product, source) {
        const handle = product.handle || (product.url && product.url.split('/products/')[1]?.split('?')[0]);
        if (handle && !this.processedProductHandles.has(handle)) {
            await this.fetchProductByHandle(handle, source);
        }
    }

    async fetchProductByHandle(handle, source) {
        if (productCache.has(handle)) {
            const cachedProduct = productCache.get(handle);
            if (!this.processedProductHandles.has(handle)) {
                this.processedProductHandles.add(handle);
                this.stats.productsFound++;
                for (const variant of cachedProduct.variants || []) {
                    this.processVariantImmediately(variant, cachedProduct, `${source} (Cached)`);
                }
            }
            return;
        }
        
        const url = `${this.baseUrl}/products/${handle}.js`;
        const data = await this.makeRequest(url);
        if (data && data.variants) {
            if (!this.processedProductHandles.has(handle)) {
                this.processedProductHandles.add(handle);
                this.stats.productsFound++;
                productCache.set(handle, data);
                for (const variant of data.variants) {
                    this.processVariantImmediately(variant, data, source);
                }
            }
        }
    }

    // ------------------ SITEMAP PARSING ------------------
    async parseSitemaps() {
        if (!this.enableSitemapParsing) return;
        
        console.log('🗺️ Parsing sitemaps...');
        this.stats.currentPhase = 'Parsing Sitemaps';
        
        const sitemapUrls = [
            `${this.baseUrl}/sitemap.xml`,
            `${this.baseUrl}/sitemap_products.xml`,
            `${this.baseUrl}/sitemap_collections.xml`,
            `${this.baseUrl}/sitemap_pages.xml`,
            `${this.baseUrl}/sitemap_products_1.xml`,
            `${this.baseUrl}/sitemap_products_2.xml`,
            `${this.baseUrl}/sitemap_products_3.xml`,
            `${this.baseUrl}/sitemap_archived.xml`,
            `${this.baseUrl}/sitemap_old.xml`,
            `${this.baseUrl}/sitemap_backup.xml`
        ];
        
        const sitemapBatches = [];
        for (let i = 0; i < sitemapUrls.length; i += 3) {
            sitemapBatches.push(sitemapUrls.slice(i, i + 3));
        }
        
        for (const batch of sitemapBatches) {
            const batchPromises = batch.map(url => this.parseSingleSitemap(url));
            await Promise.allSettled(batchPromises);
            if (this.stats.sitemapUrlsFound % 1000 === 0) cleanupMemory();
        }
        
        console.log(`🗺️ Sitemap parsing complete: ${this.stats.sitemapUrlsFound} URLs found`);
    }

    async parseSingleSitemap(sitemapUrl) {
        try {
            const response = await axios.get(sitemapUrl, {
                timeout: AXIOS_TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                proxy: PROXY_CONFIG || false,
                httpsAgent: HTTPS_AGENT
            });
            
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(response.data);
            
            if (result.urlset && result.urlset.url) {
                for (const urlEntry of result.urlset.url) {
                    if (urlEntry.loc && urlEntry.loc[0]) {
                        const url = urlEntry.loc[0];
                        this.sitemapUrls.add(url);
                        this.stats.sitemapUrlsFound++;
                        
                        if (url.includes('/products/')) {
                            const handle = url.split('/products/')[1]?.split('?')[0]?.split('#')[0];
                            if (handle && !this.processedProductHandles.has(handle)) {
                                const isAvailable = await this.checkProductAvailability(handle);
                                if (isAvailable) {
                                    await this.fetchProductByHandle(handle, 'Sitemap');
                                } else {
                                    this.variantAnalysis.discontinuedProducts.add(handle);
                                    this.stats.discontinuedProductsFound++;
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.response) {
                console.log(`🔍 Sitemap not found or inaccessible: ${sitemapUrl.split('/').pop()} (HTTP ${error.response.status})`);
            } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                console.log(`🔍 Sitemap request timed out: ${sitemapUrl.split('/').pop()}`);
            } else if (error instanceof xml2js.ParseError) {
                console.log(`🔍 Sitemap XML parsing error: ${sitemapUrl.split('/').pop()} - ${error.message}`);
            } else {
                console.log(`🔍 Sitemap error for ${sitemapUrl.split('/').pop()}: ${error.message}`);
            }
        }
    }

    async checkProductAvailability(handle) {
        if (productCache.has(handle)) return true;
        
        try {
            const response = await axios.head(`${this.baseUrl}/products/${handle}`, {
                timeout: AXIOS_TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                proxy: PROXY_CONFIG || false,
                httpsAgent: HTTPS_AGENT
            });
            
            const isAvailable = response.status === 200;
            if (isAvailable) productCache.set(handle, true);
            return isAvailable;
        } catch (error) {
            return false;
        }
    }

// ============================================================================
// SECTION 3: SCANNING METHODS - END
// ============================================================================
// ============================================================================
// SECTION 4: VARIANT PROCESSING AND ANALYSIS - START
// ============================================================================

    // Variant analysis and result construction
    processVariantImmediately(variantData, productData, source) {
        const variantId = variantData.id.toString();
        if (this.processedVariantIds.has(variantId)) return;
        
        this.processedVariantIds.add(variantId);
        this.stats.variantsProcessed++;
        
        let price = parseFloat(variantData.price);
        const item = {
            title: productData.title || variantData.product_title || 'Unknown Product',
            variant: variantData.title || '',
            price: price,
            available: variantData.available !== false,
            cartUrl: `${this.baseUrl}/cart/${variantId}:1`,
            productUrl: `${this.baseUrl}/products/${productData.handle || variantData.product_handle || ''}`,
            source: source,
            foundAt: new Date().toISOString()
        };

        // Lowest-priced item tracking
        if (FEATURE_FLAGS.SHOW_LOWEST_PRICED && price >= FEATURE_FLAGS.LOWEST_PRICED_THRESHOLD) {
            this.addLowestPricedItem(item);
        }

        // Free item tracking
        if (price < FEATURE_FLAGS.FREE_ITEMS_THRESHOLD) {
            this.freeItems.push(item);
            this.stats.freeItemsFound++;
            
            // Update filenames when first free item is found
            if (this.freeItems.length === 1) {
                this.updateFilenamesForFreeItems();
            }
            
            this.showNotification(`Free item found: ${item.title} - $${item.price.toFixed(2)}`);
        }

        if (this.enableVariantAnalysis) {
            this.analyzeVariant(variantData, productData, item);
        }

        if (this.stats.variantsProcessed % 1000 === 0) {
            this.saveCheckpoint();
            console.log(`📊 Processed ${this.stats.variantsProcessed} variants, found ${this.stats.freeItemsFound} free items, ${this.lowestPricedItems.length} lowest priced`);
        }

        if (this.stats.variantsProcessed % 5000 === 0) {
            cleanupMemory();
        }
    }

    addLowestPricedItem(item) {
        this.lowestPricedItems.push(item);
        this.lowestPricedItems.sort((a, b) => a.price - b.price);
        if (this.lowestPricedItems.length > FEATURE_FLAGS.LOWEST_PRICED_COUNT) {
            this.lowestPricedItems = this.lowestPricedItems.slice(0, FEATURE_FLAGS.LOWEST_PRICED_COUNT);
        }
        this.stats.lowestPricedFound = this.lowestPricedItems.length > 0;
    }

    analyzeVariant(variantData, productData, item) {
        this.stats.variantCombinationsAnalyzed++;
        const productHandle = productData.handle || variantData.product_handle;
        
        if (productHandle) {
            productCache.set(productHandle, productData);
            if (!this.variantAnalysis.variantCombinations.has(productHandle)) {
                this.variantAnalysis.variantCombinations.set(productHandle, []);
            }
            this.variantAnalysis.variantCombinations.get(productHandle).push({
                id: variantData.id,
                title: variantData.title,
                price: item.price,
                available: item.available,
                option1: variantData.option1,
                option2: variantData.option2,
                option3: variantData.option3
            });
        }

        const priceKey = Math.floor(item.price * 100) / 100;
        if (!this.variantAnalysis.pricePatterns.has(priceKey)) {
            this.variantAnalysis.pricePatterns.set(priceKey, 0);
        }
        this.variantAnalysis.pricePatterns.set(priceKey, this.variantAnalysis.pricePatterns.get(priceKey) + 1);

        if (variantData.inventory_quantity !== undefined) {
            this.variantAnalysis.inventoryData.set(variantData.id, {
                quantity: variantData.inventory_quantity,
                policy: variantData.inventory_policy,
                management: variantData.inventory_management
            });
        }

        variantCache.set(variantData.id, variantData);
    }

    saveAllResults() {
        let output = '';
        
        try {
            fs.writeFileSync(this.csvFile, 'Title,Variant,Price,Available,Cart URL,Product URL,Source,Found At\n');
            
            if (FEATURE_FLAGS.SHOW_LOWEST_PRICED && this.lowestPricedItems.length > 0) {
                output += `🏷️ LOWEST PRICED ITEMS (${this.lowestPricedItems.length} found):\n\n`;
                this.lowestPricedItems.forEach((item, index) => {
                    output += `LOWEST PRICED #${index + 1}: ${item.title} - $${item.price.toFixed(2)}\n`;
                    output += `  Variant: ${item.variant}\n`;
                    output += `  Available: ${item.available ? 'Yes' : 'No'}\n`;
                    output += `  Cart URL: ${item.cartUrl}\n`;
                    output += `  Product URL: ${item.productUrl}\n`;
                    output += `  Source: ${item.source}\n`;
                    output += `  Found At: ${item.foundAt}\n\n`;
                    
                    const csvRow = `"${item.title.replace(/"/g, '""')}","${item.variant.replace(/"/g, '""')}",${item.price.toFixed(2)},${item.available ? 'Yes' : 'No'},"${item.cartUrl}","${item.productUrl}","LOWEST PRICED #${index + 1}","${item.foundAt}"\n`;
                    fs.appendFileSync(this.csvFile, csvRow);
                });
            }

            if (this.freeItems.length > 0) {
                output += `🎁 FREE ITEMS FOUND (${this.freeItems.length}):\n\n`;
                this.freeItems.forEach((item, index) => {
                    output += `FREE ITEM #${index + 1}: ${item.title} - $${item.price.toFixed(2)}\n`;
                    output += `  Variant: ${item.variant}\n`;
                    output += `  Available: ${item.available ? 'Yes' : 'No'}\n`;
                    output += `  Source: ${item.source}\n`;
                    output += `  Cart URL: ${item.cartUrl}\n`;
                    output += `  Product URL: ${item.productUrl}\n`;
                    output += `  Found At: ${item.foundAt}\n\n`;
                    
                    const csvRow = `"${item.title.replace(/"/g, '""')}","${item.variant.replace(/"/g, '""')}",${item.price.toFixed(2)},${item.available ? 'Yes' : 'No'},"${item.cartUrl}","${item.productUrl}","FREE ITEM","${item.foundAt}"\n`;
                    fs.appendFileSync(this.csvFile, csvRow);
                });
                this.showNotification(`Found ${this.freeItems.length} free items at ${this.originalDomain}`);
            }

            if (this.enableVariantAnalysis && this.variantAnalysis.variantCombinations.size > 0) {
                output += `📊 VARIANT ANALYSIS:\n`;
                output += `Total products analyzed: ${this.variantAnalysis.variantCombinations.size}\n`;
                output += `Total variant combinations: ${this.stats.variantCombinationsAnalyzed}\n`;
                output += `Price points found: ${this.variantAnalysis.pricePatterns.size}\n`;
                output += `Products with inventory data: ${this.variantAnalysis.inventoryData.size}\n`;
                output += `Discontinued products: ${this.stats.discontinuedProductsFound}\n\n`;
            }

            fs.writeFileSync(this.outputFile, output);
        } catch (error) {
            console.error(`⚠️ Error saving scan results to file: ${error.message}`);
        }

        if (FEATURE_FLAGS.ENABLE_SITE_TRACKING) {
            updateTrackingFiles(this.originalDomain, this.stats.freeItemsFound > 0, this.stats.freeItemsFound);
        }

        showResultsSummary(this);
    }

    // ------------------ CART ENDPOINTS AND VARIANT GAPS ------------------
    async scanCartEndpoints() {
        console.log('🛒 Scanning cart endpoints...');
        this.stats.currentPhase = 'Cart Analysis';
        
        const cartEndpoints = [
            '/cart.js', '/cart.json', '/meta.json',
            '/config.json', '/checkout.json', '/theme.json'
        ];
        
        const endpointPromises = cartEndpoints.map(endpoint => this.processCartEndpoint(endpoint));
        await Promise.allSettled(endpointPromises);
        
        console.log('🛒 Cart endpoint scanning complete');
    }

    async processCartEndpoint(endpoint) {
        const url = `${this.baseUrl}${endpoint}`;
        const data = await this.makeRequest(url);
        if (data) await this.analyzeCartData(data, endpoint);
    }

    async analyzeCartData(data, source) {
        const content = typeof data === 'string' ? data : JSON.stringify(data);
        
        const gwpPatterns = [
            'gwpCampaign', 'giftTiers', 'minimumValue', 'freeGift',
            'bundleDiscount', 'promoCode', 'specialOffer', 'loyaltyReward'
        ];
        
        const foundGWP = gwpPatterns.some(pattern => content.includes(pattern));
        if (foundGWP) {
            console.log(`🎁 Found GWP campaign data in ${source}`);
            const gwpMatches = content.match(/"(?:productId|variantId|variant_id|product_id)"\s*:\s*(\d+)/g) || [];
            const variantPromises = [];
            
            for (const match of gwpMatches) {
                const id = match.match(/(\d+)/)[1];
                if (id.length >= 10 && !this.processedVariantIds.has(id)) {
                    variantPromises.push(this.testSingleVariant(parseInt(id), `GWP ${source}`));
                }
            }
            
            for (let i = 0; i < variantPromises.length; i += 10) {
                const batch = variantPromises.slice(i, i + 10);
                await Promise.allSettled(batch);
            }
        }

        // Probe for any large long numbers that may be variant IDs
        const variantMatches = content.match(/\b(\d{11,15})\b/g) || [];
        const variantPromises = [];
        
        for (const variantId of variantMatches) {
            if (!this.processedVariantIds.has(variantId)) {
                variantPromises.push(this.testSingleVariant(parseInt(variantId), `Cart Data ${source}`));
            }
        }
        
        for (let i = 0; i < variantPromises.length; i += 10) {
            const batch = variantPromises.slice(i, i + 10);
            await Promise.allSettled(batch);
        }
    }

    async testSingleVariant(variantId, source) {
        const url = `${this.baseUrl}/variants/${variantId}.js`;
        const data = await this.makeRequest(url);
        
        if (data && data.id) {
            const productData = {
                title: data.product_title || 'Unknown',
                handle: data.product_handle || ''
            };
            this.processVariantImmediately(data, productData, `Variant Test - ${source}`);
        }
    }

// ============================================================================
// SECTION 4: VARIANT PROCESSING AND ANALYSIS - END
// ============================================================================
// ============================================================================
// SECTION 5: ENUMERATION AND MAIN ENTRY POINTS - START
// ============================================================================

    // ------------------ ENUMERATION ROUTINES (DISABLED) ------------------
    async enumerateVariantIds() {
        console.log('⏭️ Skipping variant enumeration (disabled for performance)');
        this.stats.skippedVariantEnumeration = true;
        return;
        
        // Original enumeration code commented out for performance
        /*
        if (this.skipVariantEnumeration) {
            console.log('⏭️ Skipping variant enumeration (disabled by user)');
            this.stats.skippedVariantEnumeration = true;
            return;
        }

        if (this.processedVariantIds.size === 0) {
            console.log('⚠️ No variant IDs found to enumerate from');
            return;
        }

        console.log('🔢 Starting variant enumeration...');
        this.stats.currentPhase = 'Variant Enumeration';
        this.stats.enumerationStartTime = Date.now();
        
        const estimate = estimateEnumerationDuration(this);
        console.log(`⏱️ ${estimate.message}`);
        console.log('🎮 Interactive controls:');
        console.log(' S - Skip enumeration');
        console.log(' P - Pause/Resume');
        console.log(' Q - Quit and save');
        console.log(' Ctrl+C - Exit');
        
        const cleanupControls = setupEnumerationControls(this);
        
        try {
            const variantIds = Array.from(this.processedVariantIds).map(id => parseInt(id)).sort((a, b) => a - b);
            const min = variantIds[0], max = variantIds[variantIds.length - 1];
            console.log(`🔢 Enumerating from ${min} to ${max} (${variantIds.length} known variants)`);
            
            const enumBar = this.createProgressBar('Enumeration', max - min);
            await this.testVariantGaps(variantIds, enumBar);
            
            if (!this.skipEnumeration && !this.shouldStop) {
                await this.testVariantRangesAroundKnown(variantIds.slice(0, 5), enumBar);
            }
            
            this.stats.enumerationEndTime = Date.now();
            if (this.skipEnumeration) {
                console.log('⏭️ Enumeration skipped by user');
            } else if (this.shouldStop) {
                console.log('⏸️ Enumeration stopped by user');
            } else {
                console.log('✅ Enumeration completed successfully');
            }
        } catch (error) {
            console.error('❌ Error during variant enumeration:', error.message);
        } finally {
            cleanupControls();
            this.cleanupProgressBars();
        }
        */
    }

    // ------------------ MAIN ENTRY POINTS FOR SCAN ------------------
    async initialScan() {
        const startTime = Date.now();
        console.log('🚀 Starting enhanced scan...');
        console.log(`🎯 Target: ${this.baseUrl}`);
        
        const checkpointLoaded = this.loadCheckpoint();
        if (checkpointLoaded) console.log('📂 Resuming from checkpoint...');
        
        try {
            await this.parseSitemaps();
            await this.scanAllProducts();
            await this.scanAllCollections();
            await this.exploitSearchEndpoints();
            await this.scanCartEndpoints();
        } catch (error) {
            console.error('❌ Initial scan error:', error.message);
        }
        
        const elapsed = (Date.now() - startTime) / 1000;
        console.log('\n🏁 INITIAL SCAN COMPLETE!');
        console.log(`⏱️ Time: ${elapsed.toFixed(1)}s`);
        console.log(`📊 Variants processed: ${this.stats.variantsProcessed}`);
        console.log(`🎁 Free items found: ${this.stats.freeItemsFound}`);
        if (this.stats.lowestPricedFound) {
            console.log(`🏷️ Lowest priced items: ${this.lowestPricedItems.length}`);
        }
        
        if (globalSettings.saveResultsBeforeEnumeration) {
            console.log('\n💾 Saving initial results...');
            this.saveAllResults();
            console.log(`📁 Results saved to ${this.outputFile}`);
        }
        
        return this.stats;
    }

    async runFullScan() {
        const results = await this.initialScan();
        
        // Skip enumeration since it doesn't yield results and slows down scanning
        if (false && globalSettings.autoVariantEnumeration && this.processedVariantIds.size > 0) {
            console.log('\n🔄 Auto-starting variant enumeration...');
            await this.enumerateVariantIds();
        } else {
            console.log('\n⏭️ Skipping variant enumeration (disabled for performance)');
        }
        
        this.saveAllResults();
        this.saveCheckpoint();
        return results;
    }

} // END CLASS EnhancedShopifyScanner

// ============================================================================
// SECTION 5: ENUMERATION AND MAIN ENTRY POINTS - END
// ============================================================================
// ============================================================================
// SECTION 6: MAIN MENU AND USER INTERFACE - START
// ============================================================================

async function testPrefixesForDomain(domain) {
    const prefixes = [
        '', 'www.', 'shop.', 'secure.', 'store.', 'checkout.',
        'us.', 'account.', 'checkout-us.', 'shopify.'
    ];
    
    console.log(`\n🔍 Testing prefixes for ${domain}...`);
    
    for (const prefix of prefixes) {
        const testDomain = prefix + domain;
        const testUrl = `https://${testDomain}`;
        console.log(`🧪 Testing: ${testDomain}`);
        
        try {
            const response = await axios.get(`${testUrl}/products.json?limit=1`, {
                timeout: AXIOS_TIMEOUT,
                headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
                proxy: PROXY_CONFIG || false,
                httpsAgent: HTTPS_AGENT
            });
            
            if (response.data && response.data.products) {
                console.log(`✅ Found working Shopify store: ${testDomain}`);
                const scanner = new EnhancedShopifyScanner(testUrl, {
                    originalDomain: domain,
                    skipVariantEnumeration: false
                });
                
                console.log(`🚀 Scanning ${testDomain} for free items...`);
                const results = await scanner.runFullScan();
                
                if (results.freeItemsFound > 0) {
                    console.log(`🎉 FOUND ${results.freeItemsFound} FREE ITEMS at ${testDomain}!`);
                }
                
                if (scanner.lowestPricedItems.length > 0) {
                    console.log(`🏷️ Found ${scanner.lowestPricedItems.length} lowest priced items`);
                }
                
                return { url: testUrl, scanner: scanner, results: results };
            }
        } catch (error) {
            if (error.response) {
                console.log(`❌ ${testDomain} - Not accessible or not Shopify (HTTP ${error.response.status})`);
            } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                console.log(`❌ ${testDomain} - DNS resolution failed or connection refused`);
            } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                console.log(`❌ ${testDomain} - Request timed out`);
            } else {
                console.log(`❌ ${testDomain} - Error: ${error.message}`);
            }
        }
    }
    
    console.log(`⚠️ No working Shopify store found for ${domain}`);
    return null;
}

async function handleSingleDomain() {
    const domainInput = await askQuestion('\nEnter domain (e.g., drmtlgy.com or https://drmtlgy.com/): ');
    if (!domainInput) {
        console.log('Domain cannot be empty!');
        return;
    }
    
    const cleanDomain = cleanDomainInput(domainInput);
    if (!cleanDomain) {
        console.log('❌ Invalid domain format!');
        return;
    }
    
    console.log(`🧹 Cleaned domain: ${domainInput} → ${cleanDomain}`);
    await testPrefixesForDomain(cleanDomain);
}

async function handleMultipleDomains() {
    console.log('\nEnter domains one by one (press Enter with empty line to finish):');
    console.log('Accepted formats: drmtlgy.com, https://drmtlgy.com/, www.store.example.com, etc.');
    
    const domains = [];
    while (true) {
        const domainInput = await askQuestion(`Domain ${domains.length + 1} (or Enter to finish): `);
        if (!domainInput) break;
        
        const cleanDomain = cleanDomainInput(domainInput);
        if (cleanDomain) {
            domains.push(cleanDomain);
            console.log(`  ✅ Added: ${domainInput} → ${cleanDomain}`);
        } else {
            console.log(`  ❌ Invalid format: ${domainInput} - skipped`);
        }
    }
    
    if (domains.length === 0) {
        console.log('No valid domains entered!');
        return;
    }
    
    await processDomainList(domains, 'manual input');
}

async function handleFileInput() {
    const fileName = await askQuestion('\nEnter filename (e.g., urls.txt): ');
    if (!fileName) {
        console.log('Filename cannot be empty!');
        return;
    }
    
    if (!fs.existsSync(fileName)) {
        console.log(`❌ File '${fileName}' not found!`);
        console.log('Make sure the file is in the same folder as the scanner.');
        
        const createSample = await askQuestion('Create a sample urls.txt file? (y/n): ');
        if (createSample.toLowerCase() === 'y' || createSample.toLowerCase() === 'yes') {
            const sampleContent = `# Sample URLs file for Enhanced Shopify Scanner
# Add one domain per line - any format works!
drmtlgy.com
dukecannon.com
https://store.dsanddurga.com/
http://shop.example.com/
www.store.example.com
checkout.anotherstore.com/cart
`;
            
            try {
                fs.writeFileSync('urls.txt', sampleContent);
                console.log('✅ Created sample urls.txt file. Edit it and try again.');
            } catch (error) {
                console.error(`⚠️ Error creating sample file: ${error.message}`);
            }
        }
        return;
    }
    
    try {
        const fileContent = fs.readFileSync(fileName, 'utf8');
        const lines = fileContent.split('\n');
        const domains = [];
        
        for (const line of lines) {
            const clean = cleanDomainInput(line.trim());
            if (clean) domains.push(clean);
        }
        
        if (domains.length === 0) {
            console.log('❌ No valid domains found in file!');
            return;
        }
        
        console.log(`📁 Found ${domains.length} domains in ${fileName}:`);
        domains.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
        
        const confirm = await askQuestion(`\nProceed with scanning ${domains.length} domains? (y/n): `);
        if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
            console.log('Scan cancelled.');
            return;
        }
        
        await processDomainList(domains, `file: ${fileName}`);
    } catch (error) {
        console.log(`❌ Error reading file: ${error.message}`);
    }
}

async function processDomainList(domains, source) {
    console.log(`\n🚀 Scanning ${domains.length} domains from ${source}...`);
    const successfulScans = [];
    const failedDomains = [];
    
    const CONCURRENCY_LIMIT = 3; // Reduced concurrency for better performance with proxies
    let activePromises = [];
    
    for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        console.log(`\n[${i + 1}/${domains.length}] Processing: ${domain}`);
        console.log('='.repeat(50));
        
        const scanPromise = (async () => {
            try {
                const result = await testPrefixesForDomain(domain);
                if (result) {
                    successfulScans.push(result);
                } else {
                    failedDomains.push(domain);
                }
            } catch (error) {
                failedDomains.push(domain);
                console.log(`❌ Unexpected error during scan of ${domain}: ${error.message}`);
            }
        })();
        
        activePromises.push(scanPromise);
        
        if (activePromises.length >= CONCURRENCY_LIMIT || i === domains.length - 1) {
            await Promise.allSettled(activePromises);
            activePromises = [];
            
            if (i < domains.length - 1) {
                console.log('⏳ Waiting 3 seconds before next batch...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    
    // Final batch summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 BATCH SCAN SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total domains scanned: ${domains.length}`);
    console.log(`Successful scans: ${successfulScans.length}`);
    console.log(`Failed scans: ${failedDomains.length}`);
    
    if (successfulScans.length > 0) {
        console.log(`\n🎉 Found free items at ${successfulScans.length} domain(s)!`);
        let totalFreeItems = 0;
        let totalLowestPriced = 0;
        
        successfulScans.forEach((result, index) => {
            const scannedDomain = new URL(result.url).hostname;
            totalFreeItems += result.results.freeItemsFound;
            totalLowestPriced += result.scanner.lowestPricedItems.length;
            console.log(`  ${index + 1}. ${scannedDomain}: ${result.results.freeItemsFound} free items, ${result.scanner.lowestPricedItems.length} lowest priced`);
        });
        
        console.log(`\n🎁 Total free items found: ${totalFreeItems}`);
        console.log(`🏷️ Total lowest priced items found: ${totalLowestPriced}`);
    }
    
    if (failedDomains.length > 0) {
        console.log(`\n❌ Failed domains (${failedDomains.length}):`);
        failedDomains.forEach((domain, index) => {
            console.log(`  ${index + 1}. ${domain}`);
        });
    }
    
    console.log('\n✅ Batch scan complete!');
}

async function nonInteractiveMain(domain) {
    let success = false;
    let freeItems = 0;
    let duration = 0;
    
    try {
        loadSettings();
        console.log(`🚀 Starting non-interactive scan for ${domain}`);
        
        const cleanDomain = cleanDomainInput(domain);
        if (!cleanDomain) {
            console.log('❌ Invalid domain format!');
            return;
        }
        
        const result = await testPrefixesForDomain(cleanDomain);
        if (result) {
            success = true;
            freeItems = result.results.freeItemsFound;
            duration = ((Date.now() - result.scanner.stats.startTime) / 1000).toFixed(1);
        }
    } catch (error) {
        console.error(`❌ An unexpected error occurred: ${error.message}`);
    } finally {
        if (rl) rl.close();
        console.log('---SCANNER_RESULTS_START---');
        console.log(JSON.stringify({ success, freeItems, duration }));
        console.log('---SCANNER_RESULTS_END---');
    }
}

async function interactiveMain() {
    loadSettings();
    console.clear();
    console.log('========================================');
    console.log('  ENHANCED SHOPIFY SCANNER v2.0');
    console.log('========================================\n');
    console.log('Starting Enhanced Shopify Scanner...');
    console.log('Location:', process.cwd() + '\n');
    
    const mainSigintHandler = () => {
        console.log('\n👋 Exiting scanner...');
        saveSettings();
        rl.close();
        process.exit(0);
    };
    process.on('SIGINT', mainSigintHandler);
    
    while (true) {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.resume();
        
        console.log('\nChoose an option:');
        console.log('1. Scan single domain');
        console.log('2. Scan multiple domains (manual input)');
        console.log('3. Scan domains from file (urls.txt)');
        console.log('4. Exit');
        
        const choice = await askQuestion('\nEnter your choice (1-4) or paste a URL: ');
        process.removeListener('SIGINT', mainSigintHandler);
        
        try {
            if (isUrl(choice) || (choice.includes('.') && !['1','2','3','4'].includes(choice))) {
                console.log('🔗 URL/Domain detected, processing...');
                const cleanDomain = cleanDomainInput(choice);
                if (cleanDomain) {
                    console.log(`🧹 Processing: ${choice} → ${cleanDomain}`);
                    await testPrefixesForDomain(cleanDomain);
                } else {
                    console.log('❌ Invalid URL/domain format!');
                }
            } else if (choice === '1') {
                await handleSingleDomain();
            } else if (choice === '2') {
                await handleMultipleDomains();
            } else if (choice === '3') {
                await handleFileInput();
            } else if (choice === '4') {
                console.log('👋 Goodbye!');
                saveSettings();
                rl.close();
                process.exit(0);
            } else {
                console.log('Invalid choice. Please try again.');
            }
        } catch (error) {
            console.error(`❌ An unexpected error occurred: ${error.message}`);
        } finally {
            process.on('SIGINT', mainSigintHandler);
        }
    }
}

async function runScanForDomain(domainInput) {
    loadSettings();
    const cleanDomain = cleanDomainInput(domainInput);
    if (!cleanDomain) {
        return { success: false, error: 'Invalid domain format.' };
    }

    const result = await testPrefixesForDomain(cleanDomain);
    if (!result) {
        return { success: false, error: 'No working Shopify store found for this domain.' };
    }

    const durationSeconds = (Date.now() - result.scanner.stats.startTime) / 1000;
    return {
        success: true,
        domain: cleanDomain,
        scannedUrl: result.url,
        freeItemsFound: result.results.freeItemsFound,
        lowestPricedItems: result.scanner.lowestPricedItems,
        freeItems: result.scanner.freeItems,
        stats: result.results,
        outputFile: result.scanner.outputFile,
        csvFile: result.scanner.csvFile,
        durationSeconds: Number(durationSeconds.toFixed(1))
    };
}

module.exports = {
    EnhancedShopifyScanner,
    cleanDomainInput,
    testPrefixesForDomain,
    runScanForDomain
};

// Entry point
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length > 0) {
        nonInteractiveMain(args[0]).catch(console.error);
    } else {
        interactiveMain().catch(console.error);
    }
}

// ============================================================================
// SECTION 6: MAIN MENU AND USER INTERFACE - END
// ============================================================================
