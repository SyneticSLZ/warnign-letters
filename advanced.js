// server-advanced.js - Advanced FDA Company Intelligence System
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'FDA-Monitor/2.0' }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Enhanced Data Storage
const DATA_DIR = './data';
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const TIMELINE_FILE = path.join(DATA_DIR, 'timeline.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');

// Previous files
const LETTERS_FILE = path.join(DATA_DIR, 'warning_letters.json');
const CRL_FILE = path.join(DATA_DIR, 'crl_letters.json');
const FORM_483_FILE = path.join(DATA_DIR, 'form_483.json');
const ALL_ITEMS_FILE = path.join(DATA_DIR, 'all_items.json');

// Enhanced Feed Sources with SEC
const FEED_SOURCES = {
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
    }
  ],
  
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
      url: 'https://www.raps.org/rss/regulatory-focus',
      name: 'RAPS Regulatory Focus',
      category: 'trade',
      priority: 2
    }
  ],
  
  google_news: [
    {
      url: 'https://news.google.com/rss/search?q=%22Complete%20Response%20Letter%22%20FDA&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - CRLs',
      category: 'google',
      type: 'crl',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=FDA%20%22Form%20483%22%20observations&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - Form 483',
      category: 'google',
      type: '483',
      priority: 3
    }
  ],
  
  // SEC 8-K filings for CRL disclosures
  sec_feeds: []  // Dynamically populated based on tracked companies
};

// Enhanced Classification with severity scoring
const CLASSIFIERS = {
  warning_letter: {
    keywords: ['warning letter', 'FDA warns', 'regulatory warning'],
    severity: 8,
    impact: 'high',
    typical_timeline: '15 days to respond'
  },
  crl: {
    keywords: ['complete response letter', 'CRL', 'FDA rejects', 'approval denial'],
    severity: 9,
    impact: 'critical',
    typical_timeline: 'Resubmission in 6+ months'
  },
  form_483: {
    keywords: ['form 483', '483 observations', 'inspection observations'],
    severity: 6,
    impact: 'medium',
    typical_timeline: '15 days to respond'
  },
  opdp: {
    keywords: ['OPDP', 'untitled letter', 'promotional', 'misleading claims'],
    severity: 5,
    impact: 'medium',
    typical_timeline: '14 days to respond'
  },
  import_alert: {
    keywords: ['import alert', 'DWPE', 'detention without physical examination'],
    severity: 7,
    impact: 'high',
    typical_timeline: 'Immediate'
  },
  consent_decree: {
    keywords: ['consent decree', 'permanent injunction'],
    severity: 10,
    impact: 'critical',
    typical_timeline: 'Ongoing compliance'
  }
};

// Company Intelligence System
class CompanyIntelligence {
  constructor() {
    this.companies = new Map();
    this.alerts = [];
    this.patterns = new Map();
    this.riskScores = new Map();
  }

  async initialize() {
    try {
      const companiesData = await fs.readFile(COMPANIES_FILE, 'utf8');
      const companies = JSON.parse(companiesData);
      companies.forEach(c => this.companies.set(c.name, c));
    } catch {
      // Initialize empty
    }
  }

  // Enhanced company extraction with aliases
  extractCompany(title, content, link) {
    // Try URL-based extraction first (most reliable)
    if (link && link.includes('fda.gov')) {
      const urlMatch = link.match(/\/([A-Za-z0-9\-]+)-\d{2}-\d{2}-\d{2}/);
      if (urlMatch) {
        return this.normalizeCompanyName(urlMatch[1].replace(/-/g, ' '));
      }
    }

    // Pattern matching on title
    const patterns = [
      /^([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–:])/,
      /to\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i,
      /for\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i,
      /([A-Z][A-Za-z0-9\s&,\.]+?)\s+(?:receives?|gets?|issued)/i,
      /regarding\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match && match[1]) {
        return this.normalizeCompanyName(match[1]);
      }
    }

    return 'Unknown Company';
  }

  // Normalize company names for better matching
  normalizeCompanyName(name) {
    return name
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Company|Co\.?|Pharmaceuticals?|Pharma|Biotech|Medical|Sciences?|Therapeutics?|Holdings?|Group|International|USA|US|Global|Technologies|Tech|Health|Healthcare|Laboratories?|Labs?)\.?\s*$/gi, '')
      .trim();
  }

  // Calculate company risk score
  calculateRiskScore(companyName) {
    const company = this.companies.get(companyName) || { violations: [] };
    let score = 0;

    // Recent violations (last 2 years)
    const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    const recentViolations = company.violations.filter(v => 
      new Date(v.date).getTime() > twoYearsAgo
    );

    // Score based on violation types
    recentViolations.forEach(violation => {
      const classifier = CLASSIFIERS[violation.type];
      if (classifier) {
        score += classifier.severity;
      }
    });

    // Increase score for repeat violations
    const violationTypes = new Set(recentViolations.map(v => v.type));
    if (violationTypes.size > 1) {
      score *= 1.5; // Multiple violation types
    }

    // Frequency penalty
    if (recentViolations.length > 3) {
      score *= 1.3; // Frequent violations
    }

    return Math.min(100, Math.round(score));
  }

  // Detect patterns and trends
  detectPatterns() {
    const patterns = {
      hotspots: [],      // Companies with multiple recent violations
      escalating: [],    // Companies with increasing severity
      manufacturing: [], // Manufacturing-related issues
      clinical: [],      // Clinical trial issues
      promotional: [],   // Marketing/promotional issues
      repeat_offenders: [] // Companies with history
    };

    this.companies.forEach((company, name) => {
      const recentViolations = company.violations.filter(v => 
        Date.now() - new Date(v.date).getTime() < 90 * 24 * 60 * 60 * 1000 // 90 days
      );

      if (recentViolations.length >= 2) {
        patterns.hotspots.push({
          company: name,
          count: recentViolations.length,
          types: [...new Set(recentViolations.map(v => v.type))]
        });
      }

      // Check for escalation
      if (company.violations.length >= 2) {
        const sorted = company.violations.sort((a, b) => new Date(a.date) - new Date(b.date));
        const recent = sorted.slice(-2);
        if (recent[1] && CLASSIFIERS[recent[1].type] && CLASSIFIERS[recent[0].type]) {
          if (CLASSIFIERS[recent[1].type].severity > CLASSIFIERS[recent[0].type].severity) {
            patterns.escalating.push({
              company: name,
              from: recent[0].type,
              to: recent[1].type
            });
          }
        }
      }

      // Categorize by issue type
      company.violations.forEach(v => {
        if (v.summary) {
          const summary = v.summary.toLowerCase();
          if (summary.includes('manufactur') || summary.includes('cgmp') || summary.includes('quality')) {
            patterns.manufacturing.push({ company: name, violation: v });
          }
          if (summary.includes('clinical') || summary.includes('trial') || summary.includes('study')) {
            patterns.clinical.push({ company: name, violation: v });
          }
          if (summary.includes('promot') || summary.includes('market') || summary.includes('advertis')) {
            patterns.promotional.push({ company: name, violation: v });
          }
        }
      });

      // Repeat offenders
      if (company.violations.length >= 3) {
        patterns.repeat_offenders.push({
          company: name,
          total_violations: company.violations.length,
          types: [...new Set(company.violations.map(v => v.type))],
          risk_score: this.calculateRiskScore(name)
        });
      }
    });

    this.patterns = patterns;
    return patterns;
  }

  // Update company profile
  async updateCompany(item) {
    const companyName = this.normalizeCompanyName(item.company);
    
    if (!this.companies.has(companyName)) {
      this.companies.set(companyName, {
        name: companyName,
        aliases: [item.company],
        violations: [],
        products: [],
        facilities: [],
        risk_score: 0,
        last_updated: new Date().toISOString(),
        monitoring_since: new Date().toISOString()
      });
    }

    const company = this.companies.get(companyName);
    
    // Add violation
    const violation = {
      id: item.id,
      type: item.types[0],
      date: item.date,
      title: item.title,
      link: item.link,
      source: item.source,
      summary: item.summary,
      severity: CLASSIFIERS[item.types[0]]?.severity || 5
    };

    // Check if this is a new violation
    const exists = company.violations.some(v => v.link === violation.link);
    if (!exists) {
      company.violations.push(violation);
      company.violations.sort((a, b) => new Date(b.date) - new Date(a.date));
      
      // Keep only last 50 violations
      if (company.violations.length > 50) {
        company.violations = company.violations.slice(0, 50);
      }

      // Update risk score
      company.risk_score = this.calculateRiskScore(companyName);
      company.last_updated = new Date().toISOString();

      // Add alias if different
      if (!company.aliases.includes(item.company)) {
        company.aliases.push(item.company);
      }

      // Try to extract facility/product info from summary
      this.extractCompanyDetails(company, item.summary);

      return true; // New violation added
    }

    return false; // Already exists
  }

  // Extract additional company details
  extractCompanyDetails(company, text) {
    if (!text) return;

    // Extract facility locations
    const facilityPattern = /(?:facility|plant|site|location)\s+(?:in|at|located)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),?\s+([A-Z]{2})/gi;
    let match;
    while ((match = facilityPattern.exec(text)) !== null) {
      const facility = `${match[1]}, ${match[2]}`;
      if (!company.facilities.includes(facility)) {
        company.facilities.push(facility);
      }
    }

    // Extract product names (simplified)
    const productPattern = /(?:drug|product|medication|device|treatment)\s+([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+)?)/gi;
    while ((match = productPattern.exec(text)) !== null) {
      const product = match[1];
      if (!company.products.includes(product) && product.length > 3) {
        company.products.push(product);
      }
    }
  }

  // Get company timeline
  getCompanyTimeline(companyName) {
    const company = this.companies.get(this.normalizeCompanyName(companyName));
    if (!company) return null;

    return {
      company: company.name,
      aliases: company.aliases,
      risk_score: company.risk_score,
      total_violations: company.violations.length,
      timeline: company.violations.map(v => ({
        date: v.date,
        type: v.type,
        severity: v.severity,
        title: v.title,
        link: v.link
      })),
      facilities: company.facilities,
      products: company.products
    };
  }

  // Save all company data
  async save() {
    const companiesArray = Array.from(this.companies.values());
    await fs.writeFile(COMPANIES_FILE, JSON.stringify(companiesArray, null, 2));
    
    const patternsData = {
      updated: new Date().toISOString(),
      patterns: this.detectPatterns()
    };
    await fs.writeFile(PATTERNS_FILE, JSON.stringify(patternsData, null, 2));
  }
}

// Alert System
class AlertSystem {
  constructor() {
    this.watchlist = [];
    this.alerts = [];
    this.emailConfig = null;
  }

  async initialize() {
    try {
      const watchlistData = await fs.readFile(WATCHLIST_FILE, 'utf8');
      this.watchlist = JSON.parse(watchlistData);
    } catch {
      this.watchlist = [];
    }

    try {
      const alertsData = await fs.readFile(ALERTS_FILE, 'utf8');
      this.alerts = JSON.parse(alertsData);
    } catch {
      this.alerts = [];
    }
  }

  // Add company to watchlist
  async addToWatchlist(company, criteria = {}) {
    const entry = {
      company: company,
      added: new Date().toISOString(),
      criteria: {
        alert_on_any: criteria.alert_on_any !== false,
        alert_on_warning: criteria.alert_on_warning !== false,
        alert_on_crl: criteria.alert_on_crl !== false,
        alert_on_483: criteria.alert_on_483 !== false,
        email: criteria.email || null,
        webhook: criteria.webhook || null
      }
    };

    this.watchlist = this.watchlist.filter(w => w.company !== company);
    this.watchlist.push(entry);
    await this.saveWatchlist();
    return entry;
  }

  // Check for alerts
  async checkAlerts(newItems, companyIntel) {
    const newAlerts = [];

    for (const item of newItems) {
      const companyName = companyIntel.normalizeCompanyName(item.company);
      
      // Check if company is on watchlist
      const watchEntry = this.watchlist.find(w => 
        companyIntel.normalizeCompanyName(w.company) === companyName
      );

      if (watchEntry) {
        // Check if this type of alert is enabled
        const shouldAlert = watchEntry.criteria.alert_on_any ||
          (item.types.includes('warning_letter') && watchEntry.criteria.alert_on_warning) ||
          (item.types.includes('crl') && watchEntry.criteria.alert_on_crl) ||
          (item.types.includes('form_483') && watchEntry.criteria.alert_on_483);

        if (shouldAlert) {
          const alert = {
            id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            company: companyName,
            type: item.types[0],
            severity: CLASSIFIERS[item.types[0]]?.severity || 5,
            date: item.date,
            title: item.title,
            link: item.link,
            summary: item.summary,
            created: new Date().toISOString(),
            sent: false
          };

          newAlerts.push(alert);
          this.alerts.unshift(alert);

          // Send notifications
          if (watchEntry.criteria.email) {
            await this.sendEmailAlert(alert, watchEntry.criteria.email);
          }
          if (watchEntry.criteria.webhook) {
            await this.sendWebhookAlert(alert, watchEntry.criteria.webhook);
          }
        }
      }

      // Also check for high-severity items even if not on watchlist
      if (CLASSIFIERS[item.types[0]]?.severity >= 9) {
        const alert = {
          id: `alert-high-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          company: companyName,
          type: item.types[0],
          severity: CLASSIFIERS[item.types[0]]?.severity,
          date: item.date,
          title: item.title,
          link: item.link,
          summary: item.summary,
          created: new Date().toISOString(),
          high_severity: true
        };

        newAlerts.push(alert);
        this.alerts.unshift(alert);
      }
    }

    // Keep only last 500 alerts
    if (this.alerts.length > 500) {
      this.alerts = this.alerts.slice(0, 500);
    }

    await this.saveAlerts();
    return newAlerts;
  }

  async sendEmailAlert(alert, email) {
    // Implement email sending (requires configuration)
    console.log(`Email alert would be sent to ${email} for ${alert.company}`);
  }

  async sendWebhookAlert(alert, webhook) {
    try {
      await axios.post(webhook, {
        company: alert.company,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        link: alert.link,
        date: alert.date
      });
    } catch (error) {
      console.error('Webhook error:', error.message);
    }
  }

  async saveWatchlist() {
    await fs.writeFile(WATCHLIST_FILE, JSON.stringify(this.watchlist, null, 2));
  }

  async saveAlerts() {
    await fs.writeFile(ALERTS_FILE, JSON.stringify(this.alerts, null, 2));
  }
}

// Initialize systems
const companyIntel = new CompanyIntelligence();
const alertSystem = new AlertSystem();

// Initialize storage
async function initStorage() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const files = [
      COMPANIES_FILE, ALERTS_FILE, WATCHLIST_FILE, TIMELINE_FILE, PATTERNS_FILE,
      LETTERS_FILE, CRL_FILE, FORM_483_FILE, ALL_ITEMS_FILE
    ];
    
    for (const file of files) {
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, '[]');
        console.log(`Created: ${file}`);
      }
    }

    await companyIntel.initialize();
    await alertSystem.initialize();
  } catch (error) {
    console.error('Storage init error:', error);
  }
}

// Enhanced classification with scoring
function classifyItem(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  const types = [];
  let maxSeverity = 0;
  
  for (const [type, config] of Object.entries(CLASSIFIERS)) {
    if (config.keywords.some(keyword => text.includes(keyword))) {
      types.push(type);
      maxSeverity = Math.max(maxSeverity, config.severity);
    }
  }
  
  return {
    types: types.length > 0 ? types : ['regulatory_news'],
    severity: maxSeverity
  };
}

// Fetch RSS feed
async function fetchFeed(source) {
  const results = [];
  
  try {
    console.log(`Fetching: ${source.name}`);
    const feed = await parser.parseURL(source.url);
    
    feed.items.forEach(item => {
      const date = new Date(item.pubDate || item.isoDate || Date.now());
      const classification = classifyItem(item.title, item.contentSnippet || item.content || '');
      const company = companyIntel.extractCompany(
        item.title,
        item.content || item.contentSnippet || '',
        item.link
      );
      
      results.push({
        id: `${source.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: item.title || 'No title',
        link: item.link || item.guid || '',
        date: date.toISOString(),
        dateFormatted: date.toLocaleDateString(),
        source: source.name,
        sourceCategory: source.category,
        summary: item.contentSnippet || item.content || '',
        company: company,
        types: classification.types,
        severity: classification.severity,
        priority: source.priority || 5
      });
    });
    
    console.log(`✓ ${source.name}: ${results.length} items`);
  } catch (error) {
    console.error(`✗ ${source.name}: ${error.message}`);
  }
  
  return results;
}

// Scrape FDA Warning Letters with enhanced extraction
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
    
    $('table tbody tr, .views-table tbody tr').each((i, elem) => {
      const $row = $(elem);
      const link = $row.find('a').first();
      const href = link.attr('href');
      const title = link.text();
      
      if (href && title) {
        const fullUrl = href.startsWith('http') ? href : `https://www.fda.gov${href}`;
        const dateText = $row.find('td').last().text();
        const company = companyIntel.extractCompany(title, '', fullUrl);
        
        results.push({
          id: `FDA-WL-${Date.now()}-${i}`,
          title: title.trim(),
          link: fullUrl,
          date: new Date(dateText || Date.now()).toISOString(),
          dateFormatted: new Date(dateText || Date.now()).toLocaleDateString(),
          source: 'FDA Website Direct',
          sourceCategory: 'official',
          summary: '',
          company: company,
          types: ['warning_letter'],
          severity: CLASSIFIERS.warning_letter.severity,
          priority: 1
        });
      }
    });
    
    console.log(`✓ FDA scraping: ${results.length} warning letters`);
  } catch (error) {
    console.error(`✗ FDA scraping: ${error.message}`);
  }
  
  return results;
}

// Main aggregation with intelligence
async function aggregateAllSources() {
  console.log('\n🔄 Starting intelligent aggregation...\n');
  const allItems = [];
  const startTime = Date.now();
  
  // 1. Scrape FDA directly
  const warningLetters = await scrapeFDAWarningLetters();
  allItems.push(...warningLetters);
  
  // 2. Fetch all RSS feeds
  const allFeeds = [
    ...FEED_SOURCES.fda_official,
    ...FEED_SOURCES.trade_press,
    ...FEED_SOURCES.google_news
  ];
  
  // Add dynamic SEC feeds for watched companies
  alertSystem.watchlist.forEach(watch => {
    const ticker = watch.ticker; // Would need to add ticker lookup
    if (ticker) {
      allFeeds.push({
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=8-K&output=atom`,
        name: `SEC 8-K - ${watch.company}`,
        category: 'sec',
        priority: 2
      });
    }
  });
  
  // Process in batches
  const batchSize = 5;
  for (let i = 0; i < allFeeds.length; i += batchSize) {
    const batch = allFeeds.slice(i, i + batchSize);
    const promises = batch.map(source => fetchFeed(source));
    const results = await Promise.all(promises);
    results.forEach(items => allItems.push(...items));
  }
  
  // 3. Deduplicate
  const uniqueItems = [];
  const seenLinks = new Set();
  const newViolations = [];
  
  allItems.forEach(item => {
    const cleanLink = item.link.replace(/[?#].*$/, '').toLowerCase();
    
    if (!seenLinks.has(cleanLink)) {
      seenLinks.add(cleanLink);
      uniqueItems.push(item);
      
      // Update company intelligence
      const isNew = companyIntel.updateCompany(item);
      if (isNew) {
        newViolations.push(item);
      }
    }
  });
  
  // 4. Sort by severity and date
  uniqueItems.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    return new Date(b.date) - new Date(a.date);
  });
  
  // 5. Check for alerts
  const newAlerts = await alertSystem.checkAlerts(newViolations, companyIntel);
  
  // 6. Detect patterns
  const patterns = companyIntel.detectPatterns();
  
  // 7. Save everything
  await fs.writeFile(ALL_ITEMS_FILE, JSON.stringify(uniqueItems, null, 2));
  await companyIntel.save();
  
  // Save by type
  const byType = {
    warning_letters: uniqueItems.filter(i => i.types.includes('warning_letter')),
    crls: uniqueItems.filter(i => i.types.includes('crl')),
    form_483s: uniqueItems.filter(i => i.types.includes('form_483'))
  };
  
  await fs.writeFile(LETTERS_FILE, JSON.stringify(byType.warning_letters, null, 2));
  await fs.writeFile(CRL_FILE, JSON.stringify(byType.crls, null, 2));
  await fs.writeFile(FORM_483_FILE, JSON.stringify(byType.form_483s, null, 2));
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n📊 Intelligence Report:');
  console.log(`⏱️  Time: ${elapsed}s`);
  console.log(`📑 Total items: ${uniqueItems.length}`);
  console.log(`🏢 Companies tracked: ${companyIntel.companies.size}`);
  console.log(`🚨 New violations: ${newViolations.length}`);
  console.log(`⚡ New alerts: ${newAlerts.length}`);
  console.log(`🔥 Hotspot companies: ${patterns.hotspots.length}`);
  console.log(`📈 Escalating issues: ${patterns.escalating.length}`);
  console.log(`⚠️  Repeat offenders: ${patterns.repeat_offenders.length}`);
  
  return {
    total: uniqueItems.length,
    companies: companyIntel.companies.size,
    new_violations: newViolations.length,
    new_alerts: newAlerts.length,
    patterns: patterns,
    elapsed: elapsed
  };
}

// API Routes

// Get companies with recent activity
app.get('/api/companies', async (req, res) => {
  try {
    const { days = 30, min_risk = 0, sort = 'recent' } = req.query;
    
    const companies = Array.from(companyIntel.companies.values());
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));
    
    let filtered = companies.filter(company => {
      const hasRecentActivity = company.violations.some(v => 
        new Date(v.date) >= cutoff
      );
      return hasRecentActivity && company.risk_score >= parseInt(min_risk);
    });
    
    // Sort options
    if (sort === 'risk') {
      filtered.sort((a, b) => b.risk_score - a.risk_score);
    } else if (sort === 'violations') {
      filtered.sort((a, b) => b.violations.length - a.violations.length);
    } else {
      filtered.sort((a, b) => 
        new Date(b.last_updated) - new Date(a.last_updated)
      );
    }
    
    res.json({
      success: true,
      count: filtered.length,
      companies: filtered.slice(0, 100)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get company profile and timeline
app.get('/api/companies/:name', async (req, res) => {
  try {
    const timeline = companyIntel.getCompanyTimeline(req.params.name);
    
    if (!timeline) {
      return res.status(404).json({ 
        success: false, 
        error: 'Company not found' 
      });
    }
    
    res.json({
      success: true,
      data: timeline
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get pattern analysis
app.get('/api/patterns', async (req, res) => {
  try {
    const patterns = companyIntel.detectPatterns();
    
    res.json({
      success: true,
      updated: new Date().toISOString(),
      patterns: patterns
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const { unread = false, severity_min = 0 } = req.query;
    
    let alerts = alertSystem.alerts;
    
    if (unread === 'true') {
      alerts = alerts.filter(a => !a.sent);
    }
    
    alerts = alerts.filter(a => a.severity >= parseInt(severity_min));
    
    res.json({
      success: true,
      count: alerts.length,
      alerts: alerts.slice(0, 100)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add to watchlist
app.post('/api/watchlist', async (req, res) => {
  try {
    const { company, criteria } = req.body;
    
    if (!company) {
      return res.status(400).json({ 
        success: false, 
        error: 'Company name required' 
      });
    }
    
    const entry = await alertSystem.addToWatchlist(company, criteria);
    
    res.json({
      success: true,
      message: `${company} added to watchlist`,
      entry: entry
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get watchlist
app.get('/api/watchlist', async (req, res) => {
  try {
    res.json({
      success: true,
      count: alertSystem.watchlist.length,
      watchlist: alertSystem.watchlist
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove from watchlist
app.delete('/api/watchlist/:company', async (req, res) => {
  try {
    alertSystem.watchlist = alertSystem.watchlist.filter(w => 
      w.company !== req.params.company
    );
    await alertSystem.saveWatchlist();
    
    res.json({
      success: true,
      message: `${req.params.company} removed from watchlist`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Risk assessment endpoint
app.get('/api/risk-assessment', async (req, res) => {
  try {
    const companies = Array.from(companyIntel.companies.values());
    
    const assessment = {
      high_risk: companies.filter(c => c.risk_score >= 70),
      medium_risk: companies.filter(c => c.risk_score >= 40 && c.risk_score < 70),
      low_risk: companies.filter(c => c.risk_score < 40),
      trending: companies
        .filter(c => c.violations.length >= 2)
        .sort((a, b) => {
          const aRecent = a.violations[0]?.date || 0;
          const bRecent = b.violations[0]?.date || 0;
          return new Date(bRecent) - new Date(aRecent);
        })
        .slice(0, 10)
    };
    
    res.json({
      success: true,
      assessment: assessment,
      summary: {
        high_risk_count: assessment.high_risk.length,
        medium_risk_count: assessment.medium_risk.length,
        low_risk_count: assessment.low_risk.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Industry insights
app.get('/api/insights', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));
    
    const allData = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    const items = JSON.parse(allData);
    const recentItems = items.filter(i => new Date(i.date) >= cutoff);
    
    // Generate insights
    const insights = {
      period: `${days} days`,
      total_actions: recentItems.length,
      by_type: {},
      by_severity: {
        critical: recentItems.filter(i => i.severity >= 9).length,
        high: recentItems.filter(i => i.severity >= 7 && i.severity < 9).length,
        medium: recentItems.filter(i => i.severity >= 5 && i.severity < 7).length,
        low: recentItems.filter(i => i.severity < 5).length
      },
      top_companies: [],
      enforcement_trends: [],
      geographic_distribution: {}
    };
    
    // Count by type
    recentItems.forEach(item => {
      item.types.forEach(type => {
        insights.by_type[type] = (insights.by_type[type] || 0) + 1;
      });
    });
    
    // Top companies by violation count
    const companyCount = {};
    recentItems.forEach(item => {
      const company = companyIntel.normalizeCompanyName(item.company);
      companyCount[company] = (companyCount[company] || 0) + 1;
    });
    
    insights.top_companies = Object.entries(companyCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([company, count]) => ({ company, count }));
    
    res.json({
      success: true,
      insights: insights
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Previous endpoints (items, stats, etc.) remain the same...
app.get('/api/items', async (req, res) => {
  try {
    const { type, days = 30, company, severity_min } = req.query;
    
    let data = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    let items = JSON.parse(data);
    
    if (type) {
      items = items.filter(item => item.types.includes(type));
    }
    
    if (days && days !== 'all') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(days));
      items = items.filter(item => new Date(item.date) >= cutoff);
    }
    
    if (company) {
      const normalized = companyIntel.normalizeCompanyName(company);
      items = items.filter(item => 
        companyIntel.normalizeCompanyName(item.company) === normalized
      );
    }
    
    if (severity_min) {
      items = items.filter(item => item.severity >= parseInt(severity_min));
    }
    
    res.json({
      success: true,
      count: items.length,
      items: items.slice(0, 100)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh with intelligence
app.post('/api/refresh', async (req, res) => {
  try {
    const stats = await aggregateAllSources();
    res.json({
      success: true,
      message: 'Data refreshed with intelligence analysis',
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
async function start() {
  await initStorage();
  
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🏥 FDA Regulatory Intelligence System v2.0');
    console.log('='.repeat(60));
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API Base: http://localhost:${PORT}/api`);
    console.log('\n🧠 Intelligence Features:');
    console.log('  • Company risk scoring');
    console.log('  • Pattern detection');
    console.log('  • Alert system');
    console.log('  • Trend analysis');
    console.log('  • Watchlist monitoring');
    console.log('\n🔄 Initializing intelligence systems...\n');
  });
  
  // Initial data fetch
  const stats = await aggregateAllSources();
  
  // Set up automatic refresh every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('\n⏰ Scheduled intelligence refresh...');
    await aggregateAllSources();
  });
  
  console.log('\n✨ Intelligence system ready!');
  console.log('='.repeat(60) + '\n');
}

start();