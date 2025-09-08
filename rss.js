// server.js - Comprehensive FDA Regulatory Monitor
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'FDA-Monitor/1.0'
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Data storage files
const DATA_DIR = './data';
const LETTERS_FILE = path.join(DATA_DIR, 'warning_letters.json');
const CRL_FILE = path.join(DATA_DIR, 'crl_letters.json');
const FORM_483_FILE = path.join(DATA_DIR, 'form_483.json');
const ALL_ITEMS_FILE = path.join(DATA_DIR, 'all_items.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

// Feed Sources Configuration
const FEED_SOURCES = {
  // Official FDA Feeds
  fda_official: [
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
      name: 'FDA Press Announcements',
      category: 'official',
      priority: 1
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/whats-new-drugs/rss.xml',
      name: 'FDA CDER Updates',
      category: 'official',
      priority: 1
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml',
      name: 'FDA MedWatch Safety',
      category: 'official',
      priority: 1
    }
  ],
  
  // Industry Trade Press
  trade_press: [
    {
      url: 'https://www.fiercepharma.com/rss/xml',
      name: 'FiercePharma',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.fiercebiotech.com/rss/xml',
      name: 'FierceBiotech',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.statnews.com/category/pharma/feed/',
      name: 'STAT News Pharma',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.statnews.com/category/biotech/feed/',
      name: 'STAT News Biotech',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.biospace.com/rss',
      name: 'BioSpace',
      category: 'trade',
      priority: 3
    },
    {
      url: 'https://www.raps.org/rss/regulatory-focus',
      name: 'RAPS Regulatory Focus',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.biopharmadive.com/feeds/news/',
      name: 'BioPharma Dive',
      category: 'trade',
      priority: 3
    }
  ],
  
  // Google News Queries
  google_news: [
    {
      url: 'https://news.google.com/rss/search?q=%22Complete%20Response%20Letter%22%20FDA&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - CRLs',
      category: 'google',
      type: 'crl',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=site%3Afda.gov%20%22Warning%20Letters%22&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - FDA Warning Letters',
      category: 'google',
      type: 'warning',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=site%3Afda.gov%20OPDP%20%28%22Untitled%20Letter%22%20OR%20%22Warning%20Letter%22%29&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - OPDP Letters',
      category: 'google',
      type: 'opdp',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=FDA%20%22Form%20483%22%20observations&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - Form 483',
      category: 'google',
      type: '483',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=%28%22Complete%20Response%20Letter%22%20OR%20CRL%29%20site%3Aendpts.com%20OR%20site%3Astatnews.com%20OR%20site%3Afiercebiotech.com%20OR%20site%3Afiercepharma.com&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - CRL Trade Coverage',
      category: 'google',
      type: 'crl',
      priority: 3
    }
  ]
};

// Classification keywords
const CLASSIFIERS = {
  warning_letter: [
    'warning letter', 'warning letters', 'FDA warns', 'FDA warning',
    'compliance warning', 'regulatory warning'
  ],
  crl: [
    'complete response letter', 'CRL', 'complete response', 
    'FDA rejects', 'FDA declines', 'approval denial'
  ],
  form_483: [
    'form 483', '483 observations', '483 inspection', 
    'inspection observations', 'FDA 483'
  ],
  opdp: [
    'OPDP', 'untitled letter', 'promotional', 'misleading claims',
    'false or misleading', 'office of prescription drug promotion'
  ],
  enforcement: [
    'import alert', 'seizure', 'injunction', 'consent decree',
    'recall', 'enforcement action', 'compliance action'
  ]
};

// Initialize storage
async function initStorage() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const files = [LETTERS_FILE, CRL_FILE, FORM_483_FILE, ALL_ITEMS_FILE, CACHE_FILE];
    for (const file of files) {
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, '[]');
        console.log(`Created: ${file}`);
      }
    }
  } catch (error) {
    console.error('Storage init error:', error);
  }
}

// Load cache
async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save cache
async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Classify item type
function classifyItem(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  const types = [];
  
  for (const [type, keywords] of Object.entries(CLASSIFIERS)) {
    if (keywords.some(keyword => text.includes(keyword))) {
      types.push(type);
    }
  }
  
  return types.length > 0 ? types : ['regulatory_news'];
}

// Extract company name
function extractCompanyName(title, content) {
  const text = title || '';
  
  // Common patterns
  const patterns = [
    /to\s+([A-Z][^-–,]+?)(?:\s*[-–,]|$)/i,
    /:\s+([A-Z][^-–,]+?)(?:\s*[-–,]|$)/i,
    /regarding\s+([A-Z][^-–,]+?)(?:\s*[-–,]|$)/i,
    /for\s+([A-Z][^-–,]+?)(?:\s*[-–,]|$)/i,
    /([A-Z][A-Za-z\s&]+?)\s+(?:receives?|gets?|issued)/i,
    /^([A-Z][A-Za-z\s&]+?)(?:\s*[-–:])/
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // Fallback: first part before delimiter
  const delimiters = [' - ', ' – ', ': ', ' | '];
  for (const delimiter of delimiters) {
    if (text.includes(delimiter)) {
      return text.split(delimiter)[0].trim();
    }
  }
  
  return 'Unknown Company';
}

// Parse date robustly
function parseDate(dateText) {
  if (!dateText) return new Date();
  
  const date = new Date(dateText);
  return isNaN(date) ? new Date() : date;
}

// Fetch RSS feed
async function fetchFeed(source) {
  const results = [];
  
  try {
    console.log(`Fetching: ${source.name}`);
    const feed = await parser.parseURL(source.url);
    
    feed.items.forEach(item => {
      const date = parseDate(item.pubDate || item.isoDate);
      const types = classifyItem(item.title, item.contentSnippet || item.content || '');
      
      results.push({
        id: `${source.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: item.title || 'No title',
        link: item.link || item.guid || '',
        date: date.toISOString(),
        dateFormatted: date.toLocaleDateString(),
        source: source.name,
        sourceCategory: source.category,
        summary: item.contentSnippet || item.content || '',
        company: extractCompanyName(item.title, item.content),
        types: types,
        priority: source.priority || 5
      });
    });
    
    console.log(`✓ ${source.name}: ${results.length} items`);
  } catch (error) {
    console.error(`✗ ${source.name}: ${error.message}`);
  }
  
  return results;
}

// Scrape FDA Warning Letters page
async function scrapeFDAWarningLetters() {
  const results = [];
  
  try {
    console.log('Scraping FDA Warning Letters page...');
    const response = await axios.get(
      'https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters',
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      }
    );
    
    const $ = cheerio.load(response.data);
    
    // Multiple possible selectors
    const selectors = [
      'table tbody tr',
      '.views-table tbody tr',
      '.warning-letter-list tr',
      'article.node--type-warning-letter',
      '.view-warning-letters tbody tr'
    ];
    
    for (const selector of selectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        elements.each((i, elem) => {
          const $row = $(elem);
          const link = $row.find('a').first();
          const href = link.attr('href');
          const title = link.text() || $row.find('td').first().text();
          
          if (href && title) {
            const fullUrl = href.startsWith('http') ? href : `https://www.fda.gov${href}`;
            const dateText = $row.find('td').last().text() || 
                           $row.find('.date').text() || 
                           $row.find('time').text();
            
            results.push({
              id: `FDA-WL-${Date.now()}-${i}`,
              title: title.trim(),
              link: fullUrl,
              date: parseDate(dateText).toISOString(),
              dateFormatted: parseDate(dateText).toLocaleDateString(),
              source: 'FDA Website Direct',
              sourceCategory: 'official',
              summary: '',
              company: extractCompanyName(title.trim()),
              types: ['warning_letter'],
              priority: 1
            });
          }
        });
        
        if (results.length > 0) break;
      }
    }
    
    console.log(`✓ FDA scraping: ${results.length} warning letters`);
  } catch (error) {
    console.error(`✗ FDA scraping: ${error.message}`);
  }
  
  return results;
}

// Main aggregation function
async function aggregateAllSources() {
  console.log('\n🔄 Starting full aggregation...\n');
  const allItems = [];
  const startTime = Date.now();
  
  // 1. Scrape FDA Warning Letters directly
  const warningLetters = await scrapeFDAWarningLetters();
  allItems.push(...warningLetters);
  
  // 2. Fetch all RSS feeds
  const allFeeds = [
    ...FEED_SOURCES.fda_official,
    ...FEED_SOURCES.trade_press,
    ...FEED_SOURCES.google_news
  ];
  
  // Process feeds in batches to avoid overwhelming
  const batchSize = 5;
  for (let i = 0; i < allFeeds.length; i += batchSize) {
    const batch = allFeeds.slice(i, i + batchSize);
    const promises = batch.map(source => fetchFeed(source));
    const results = await Promise.all(promises);
    results.forEach(items => allItems.push(...items));
  }
  
  // 3. Deduplicate based on link
  const uniqueItems = [];
  const seenLinks = new Set();
  
  allItems.forEach(item => {
    // Clean the link for better deduplication
    const cleanLink = item.link.replace(/[?#].*$/, '').toLowerCase();
    
    if (!seenLinks.has(cleanLink)) {
      seenLinks.add(cleanLink);
      uniqueItems.push(item);
    }
  });
  
  // 4. Sort by date (newest first) and priority
  uniqueItems.sort((a, b) => {
    const dateCompare = new Date(b.date) - new Date(a.date);
    if (dateCompare !== 0) return dateCompare;
    return a.priority - b.priority;
  });
  
  // 5. Save to files by type
  const warningLetterItems = uniqueItems.filter(item => 
    item.types.includes('warning_letter')
  );
  const crlItems = uniqueItems.filter(item => 
    item.types.includes('crl')
  );
  const form483Items = uniqueItems.filter(item => 
    item.types.includes('form_483')
  );
  
  await fs.writeFile(LETTERS_FILE, JSON.stringify(warningLetterItems, null, 2));
  await fs.writeFile(CRL_FILE, JSON.stringify(crlItems, null, 2));
  await fs.writeFile(FORM_483_FILE, JSON.stringify(form483Items, null, 2));
  await fs.writeFile(ALL_ITEMS_FILE, JSON.stringify(uniqueItems, null, 2));
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n📊 Aggregation Complete:');
  console.log(`⏱️  Time: ${elapsed}s`);
  console.log(`📑 Total items: ${uniqueItems.length}`);
  console.log(`⚠️  Warning Letters: ${warningLetterItems.length}`);
  console.log(`📋 CRLs: ${crlItems.length}`);
  console.log(`🔍 Form 483s: ${form483Items.length}`);
  
  return {
    total: uniqueItems.length,
    warningLetters: warningLetterItems.length,
    crls: crlItems.length,
    form483s: form483Items.length,
    elapsed: elapsed
  };
}

// API Routes

// Get all items with filtering
app.get('/api/items', async (req, res) => {
  try {
    const { type, days = 30, source, company, limit = 100 } = req.query;
    
    let data = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    let items = JSON.parse(data);
    
    // Filter by type
    if (type) {
      items = items.filter(item => item.types.includes(type));
    }
    
    // Filter by timeframe
    if (days && days !== 'all') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(days));
      items = items.filter(item => new Date(item.date) >= cutoff);
    }
    
    // Filter by source
    if (source) {
      items = items.filter(item => 
        item.source.toLowerCase().includes(source.toLowerCase())
      );
    }
    
    // Filter by company
    if (company) {
      items = items.filter(item => 
        item.company.toLowerCase().includes(company.toLowerCase())
      );
    }
    
    // Apply limit
    items = items.slice(0, parseInt(limit));
    
    res.json({
      success: true,
      count: items.length,
      filters: { type, days, source, company },
      items: items
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get specific type endpoints
app.get('/api/warning-letters', async (req, res) => {
  try {
    const data = await fs.readFile(LETTERS_FILE, 'utf8');
    const items = JSON.parse(data);
    res.json({
      success: true,
      count: items.length,
      items: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/crls', async (req, res) => {
  try {
    const data = await fs.readFile(CRL_FILE, 'utf8');
    const items = JSON.parse(data);
    res.json({
      success: true,
      count: items.length,
      items: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/form-483s', async (req, res) => {
  try {
    const data = await fs.readFile(FORM_483_FILE, 'utf8');
    const items = JSON.parse(data);
    res.json({
      success: true,
      count: items.length,
      items: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh data
app.post('/api/refresh', async (req, res) => {
  try {
    const stats = await aggregateAllSources();
    res.json({
      success: true,
      message: 'Data refreshed successfully',
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const allData = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    const items = JSON.parse(allData);
    
    const now = new Date();
    const stats = {
      total: items.length,
      byType: {},
      bySource: {},
      byTimeframe: {
        last24h: 0,
        last7days: 0,
        last30days: 0
      },
      lastUpdate: items[0]?.date || null
    };
    
    // Count by type
    CLASSIFIERS && Object.keys(CLASSIFIERS).forEach(type => {
      stats.byType[type] = items.filter(item => 
        item.types.includes(type)
      ).length;
    });
    
    // Count by source category
    items.forEach(item => {
      const category = item.sourceCategory || 'unknown';
      stats.bySource[category] = (stats.bySource[category] || 0) + 1;
      
      // Timeframe counts
      const age = now - new Date(item.date);
      if (age < 86400000) stats.byTimeframe.last24h++;
      if (age < 604800000) stats.byTimeframe.last7days++;
      if (age < 2592000000) stats.byTimeframe.last30days++;
    });
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feed sources info
app.get('/api/sources', (req, res) => {
  const sources = {
    official: FEED_SOURCES.fda_official.map(s => ({
      name: s.name,
      url: s.url
    })),
    trade_press: FEED_SOURCES.trade_press.map(s => ({
      name: s.name,
      url: s.url
    })),
    google_news: FEED_SOURCES.google_news.map(s => ({
      name: s.name,
      url: s.url,
      type: s.type
    }))
  };
  
  res.json(sources);
});

// Search functionality
app.get('/api/search', async (req, res) => {
  try {
    const { q, in: searchIn = 'all' } = req.query;
    
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query required' 
      });
    }
    
    const data = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    let items = JSON.parse(data);
    
    const query = q.toLowerCase();
    
    items = items.filter(item => {
      const searchFields = searchIn === 'all' 
        ? `${item.title} ${item.summary} ${item.company}`.toLowerCase()
        : searchIn === 'title' 
        ? item.title.toLowerCase()
        : searchIn === 'company'
        ? item.company.toLowerCase()
        : item.summary.toLowerCase();
      
      return searchFields.includes(query);
    });
    
    res.json({
      success: true,
      query: q,
      count: items.length,
      items: items.slice(0, 50) // Limit search results
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Company tracking
app.post('/api/track-company', async (req, res) => {
  try {
    const { company } = req.body;
    
    if (!company) {
      return res.status(400).json({ 
        success: false, 
        error: 'Company name required' 
      });
    }
    
    // Add custom Google News query for this company
    const customQuery = {
      url: `https://news.google.com/rss/search?q=(${encodeURIComponent(company)})%20(FDA%20OR%20Warning%20Letter%20OR%20CRL%20OR%20%22Complete%20Response%20Letter%22%20OR%20483)&hl=en-US&gl=US&ceid=US:en`,
      name: `Company Watch: ${company}`,
      category: 'custom',
      priority: 2
    };
    
    const items = await fetchFeed(customQuery);
    
    res.json({
      success: true,
      company: company,
      count: items.length,
      items: items
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Start server
async function start() {
  await initStorage();
  
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🏥 FDA Regulatory Monitor - Enhanced Edition');
    console.log('='.repeat(60));
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API Base: http://localhost:${PORT}/api`);
    console.log('\n📦 Monitoring:');
    console.log('  • FDA Warning Letters');
    console.log('  • Complete Response Letters (CRLs)');
    console.log('  • Form 483 Observations');
    console.log('  • OPDP Letters');
    console.log('  • Enforcement Actions');
    console.log('\n🔄 Fetching initial data...\n');
  });
  
  // Initial data fetch
  const stats = await aggregateAllSources();
  
  // Set up automatic refresh (every 30 minutes)
  cron.schedule('*/30 * * * *', async () => {
    console.log('\n⏰ Scheduled refresh starting...');
    await aggregateAllSources();
  });
  
  console.log('\n✨ Ready! Automatic refresh every 30 minutes.');
  console.log('='.repeat(60) + '\n');
}

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

start();