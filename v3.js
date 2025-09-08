// server-enhanced.js - FDA Intelligence System with Email Finding & Automated Reporting
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const webpush = require('web-push');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'FDA-Monitor/3.0' }
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
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');

// Previous files
const LETTERS_FILE = path.join(DATA_DIR, 'warning_letters.json');
const CRL_FILE = path.join(DATA_DIR, 'crl_letters.json');
const FORM_483_FILE = path.join(DATA_DIR, 'form_483.json');
const ALL_ITEMS_FILE = path.join(DATA_DIR, 'all_items.json');

// API Keys (store in environment variables in production)
const API_KEYS = {
  // HUNTER: process.env.HUNTER_API_KEY || 
  // APOLLO: process.env.APOLLO_API_KEY || 
  // CLEARBIT: process.env.CLEARBIT_API_KEY || 'your_clearbit_api_key',
  // SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  // SMTP_USER: process.env.SMTP_USER || 'your_email@gmail.com',
  // SMTP_PASS: process.env.SMTP_PASS || 'your_app_password',
  // VAPID_PUBLIC: process.env.VAPID_PUBLIC || ,
};

// Configure push notifications
if (API_KEYS.VAPID_PUBLIC && API_KEYS.VAPID_PRIVATE) {
  webpush.setVapidDetails(
    'mailto:' + API_KEYS.SMTP_USER,
    API_KEYS.VAPID_PUBLIC,
    API_KEYS.VAPID_PRIVATE
  );
}

// Configure email transporter
const emailTransporter = nodemailer.createTransport({
  host: API_KEYS.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: API_KEYS.SMTP_USER,
    pass: API_KEYS.SMTP_PASS
  }
});

// Enhanced Feed Sources (keeping original)
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
  ]
};

// Classification system (keeping original)
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

// Enhanced Company Intelligence with Contact Finding
class CompanyIntelligence {
  constructor() {
    this.companies = new Map();
    this.alerts = [];
    this.patterns = new Map();
    this.riskScores = new Map();
    this.contacts = new Map();
    this.knownCompanies = new Set(); // Track known company names
  }

  async initialize() {
    try {
      const companiesData = await fs.readFile(COMPANIES_FILE, 'utf8');
      const companies = JSON.parse(companiesData);
      companies.forEach(c => {
        this.companies.set(c.name, c);
        this.knownCompanies.add(c.name.toLowerCase());
      });
    } catch {
      // Initialize empty
    }

    try {
      const contactsData = await fs.readFile(CONTACTS_FILE, 'utf8');
      const contacts = JSON.parse(contactsData);
      contacts.forEach(c => this.contacts.set(c.company, c));
    } catch {
      // Initialize empty
    }
  }

  // Fixed company extraction with better parsing
  extractCompany(title, content, link) {
    // Clean the title first
    title = this.cleanTitle(title);
    
    // Method 1: FDA URL pattern extraction (most reliable)
    if (link && link.includes('fda.gov')) {
      // Check for warning letter URL pattern
      const urlPatterns = [
        /\/([a-z0-9\-]+)-\d{2}-\d{2}-\d{4}/i,
        /\/([a-z0-9\-]+)-\d{6}/i,
        /company\/([a-z0-9\-]+)/i
      ];
      
      for (const pattern of urlPatterns) {
        const match = link.match(pattern);
        if (match && match[1]) {
          const extracted = this.normalizeCompanyName(match[1].replace(/-/g, ' '));
          if (this.isValidCompanyName(extracted)) {
            return extracted;
          }
        }
      }
    }

    // Method 2: Direct pattern matching for FDA citations
    const patterns = [
      // FDA warning letter patterns
      /^Warning Letter to\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–:]|\s+regarding|\s+concerning)/i,
      /^([A-Z][A-Za-z0-9\s&,\.]+?)\s*[-–:]\s*Warning Letter/i,
      /^([A-Z][A-Za-z0-9\s&,\.]+?)\s+Warning Letter/i,
      
      // CRL patterns
      /^([A-Z][A-Za-z0-9\s&,\.]+?)\s+(?:Receives?|Gets?)\s+(?:Complete Response Letter|CRL)/i,
      /Complete Response Letter.*?to\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s|$)/i,
      /CRL.*?(?:for|to)\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s|$)/i,
      
      // Form 483 patterns
      /Form 483.*?(?:for|to|issued to)\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i,
      /^([A-Z][A-Za-z0-9\s&,\.]+?)\s+Form 483/i,
      
      // General FDA action patterns
      /FDA (?:Issues?|Sends?|Cites?)\s+.*?to\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i,
      /^([A-Z][A-Za-z0-9\s&,\.]+?)\s+(?:Under|Faces?|Receives?)\s+(?:FDA|US FDA)\s+(?:Scrutiny|Action|Warning)/i,
      
      // Import alert patterns
      /Import Alert.*?(?:for|against)\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,]|$)/i
    ];

    // Try each pattern
    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match && match[1]) {
        const extracted = this.normalizeCompanyName(match[1]);
        if (this.isValidCompanyName(extracted)) {
          return extracted;
        }
      }
    }

    // Method 3: Known company matching
    const titleLower = title.toLowerCase();
    for (const knownCompany of this.knownCompanies) {
      if (titleLower.includes(knownCompany)) {
        // Find the proper case version
        for (const [name, company] of this.companies) {
          if (name.toLowerCase() === knownCompany) {
            return name;
          }
        }
      }
    }

    // Method 4: Smart extraction from content
    if (content) {
      const contentPatterns = [
        /(?:letter|warning|alert|action)\s+(?:to|for|against)\s+([A-Z][A-Za-z0-9\s&,\.]+?)(?:\s*[-–,.]|\s+(?:regarding|concerning|about))/i,
        /([A-Z][A-Za-z0-9\s&,\.]+?)\s+(?:has|have)\s+received\s+(?:a|an)\s+(?:warning|letter|form|CRL)/i
      ];

      for (const pattern of contentPatterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          const extracted = this.normalizeCompanyName(match[1]);
          if (this.isValidCompanyName(extracted)) {
            return extracted;
          }
        }
      }
    }

    // Method 5: Extract first proper noun phrase that looks like a company
    const properNounPattern = /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*(?:\s+(?:Pharma|Pharmaceuticals?|Inc|LLC|Ltd|Corp|Company|Co|Biotech|Medical|Sciences?|Therapeutics?|Laboratories?|Labs?))?)/;
    const match = title.match(properNounPattern);
    if (match && match[1]) {
      const extracted = this.normalizeCompanyName(match[1]);
      if (this.isValidCompanyName(extracted)) {
        return extracted;
      }
    }

    return 'Unknown Company';
  }

  // Clean title to remove common prefixes/suffixes
  cleanTitle(title) {
    // Remove common news/article prefixes
    title = title.replace(/^(BREAKING:|UPDATE:|NEWS:|ALERT:|FDA:|US FDA:)\s*/gi, '');
    
    // Remove dates at the beginning or end
    title = title.replace(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\s*[-:]?\s*/g, '');
    title = title.replace(/\s*[-:]\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/g, '');
    
    return title.trim();
  }

  // Validate if extracted text is likely a company name
// Replace the isValidCompanyName method in your CompanyIntelligence class with this:
isValidCompanyName(name) {
  if (!name || name === 'Unknown Company') return false;
  
  // Too short or too long
  if (name.length < 2 || name.length > 100) return false;  // Changed from 3 to 2
  
  // Only check for the most obvious invalid patterns
  const invalidPatterns = [
    /^(FDA|US FDA|Warning Letter|Form|Complete Response|CRL|Import Alert)$/i,  // Removed many terms
    /^\d+$/,
    /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i,
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i
  ];
  
  for (const pattern of invalidPatterns) {
    if (pattern.test(name)) return false;
  }
  
  return true;  // Removed uppercase letter requirement
}

  // Enhanced company name normalization
  normalizeCompanyName(name) {
    if (!name) return 'Unknown Company';
    
    // Trim and clean up spacing
    name = name.trim().replace(/\s+/g, ' ');
    
    // Remove trailing punctuation
    name = name.replace(/[,;:\.\-–—]+$/, '');
    
    // Common company suffixes to preserve or remove based on context
    const suffixPattern = /\s*((?:,\s*)?(?:Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?|plc|PLC|GmbH|SA|NV|BV|AG|KG|SRL|SL)\.?)$/i;
    const suffixMatch = name.match(suffixPattern);
    
    // Remove generic suffixes but keep specific ones
    const genericSuffixes = /\s*(Company|Co\.?|Corporation)\.?$/i;
    if (genericSuffixes.test(name) && name.replace(genericSuffixes, '').length > 2) {
      name = name.replace(genericSuffixes, '');
    }
    
    // Special handling for pharmaceutical companies
    const pharmaPattern = /\s*(Pharmaceuticals?|Pharma|Biotech|Biopharma|Medical|Sciences?|Therapeutics?|Holdings?|Group|International|Global|USA?|Laboratories?|Labs?)\.?$/gi;
    
    // Keep the pharma suffix if it's part of the official name
    const baseName = name.replace(pharmaPattern, '').trim();
    
    // If removing pharma suffix leaves a very short name, keep it
    if (baseName.length < 5 && name.includes('Pharma')) {
      return name;
    }
    
    // Check if this is a known company format
    const knownFormats = [
      /^[A-Z]+$/,  // All caps abbreviation (like "FDA", "GSK")
      /^[A-Z][a-z]+$/,  // Single word company (like "Pfizer", "Merck")
    ];
    
    for (const format of knownFormats) {
      if (format.test(baseName)) {
        return baseName;
      }
    }
    
    // Return the cleaned base name
    return baseName.length > 2 ? baseName : name;
  }

  calculateRiskScore(companyName) {
    const company = this.companies.get(companyName) || { violations: [] };
    let score = 0;

    const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    const recentViolations = company.violations.filter(v => 
      new Date(v.date).getTime() > twoYearsAgo
    );

    recentViolations.forEach(violation => {
      const classifier = CLASSIFIERS[violation.type];
      if (classifier) {
        score += classifier.severity;
      }
    });

    const violationTypes = new Set(recentViolations.map(v => v.type));
    if (violationTypes.size > 1) {
      score *= 1.5;
    }

    if (recentViolations.length > 3) {
      score *= 1.3;
    }

    return Math.min(100, Math.round(score));
  }

  detectPatterns() {
    const patterns = {
      hotspots: [],
      escalating: [],
      manufacturing: [],
      clinical: [],
      promotional: [],
      repeat_offenders: []
    };

    this.companies.forEach((company, name) => {
      const recentViolations = company.violations.filter(v => 
        Date.now() - new Date(v.date).getTime() < 90 * 24 * 60 * 60 * 1000
      );

      if (recentViolations.length >= 2) {
        patterns.hotspots.push({
          company: name,
          count: recentViolations.length,
          types: [...new Set(recentViolations.map(v => v.type))]
        });
      }

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

  async updateCompany(item) {
    const companyName = this.normalizeCompanyName(item.company);
    
    // Skip invalid company names
  // To this (to see but not skip):
if (!this.isValidCompanyName(companyName)) {
  console.log(`Warning - potentially invalid company name: ${companyName} (keeping it anyway)`);
  // Don't return false - let it continue
}
    
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
      
      // Add to known companies
      this.knownCompanies.add(companyName.toLowerCase());
    }

    const company = this.companies.get(companyName);
    
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

    const exists = company.violations.some(v => v.link === violation.link);
    if (!exists) {
      company.violations.push(violation);
      company.violations.sort((a, b) => new Date(b.date) - new Date(a.date));
      
      if (company.violations.length > 50) {
        company.violations = company.violations.slice(0, 50);
      }

      company.risk_score = this.calculateRiskScore(companyName);
      company.last_updated = new Date().toISOString();

      if (!company.aliases.includes(item.company)) {
        company.aliases.push(item.company);
      }

      this.extractCompanyDetails(company, item.summary);

      // Fetch contact information for new violations
      await this.findContactsForCompany(companyName);

      return true;
    }

    return false;
  }

  extractCompanyDetails(company, text) {
    if (!text) return;

    const facilityPattern = /(?:facility|plant|site|location)\s+(?:in|at|located)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),?\s+([A-Z]{2})/gi;
    let match;
    while ((match = facilityPattern.exec(text)) !== null) {
      const facility = `${match[1]}, ${match[2]}`;
      if (!company.facilities.includes(facility)) {
        company.facilities.push(facility);
      }
    }

    const productPattern = /(?:drug|product|medication|device|treatment)\s+([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+)?)/gi;
    while ((match = productPattern.exec(text)) !== null) {
      const product = match[1];
      if (!company.products.includes(product) && product.length > 3) {
        company.products.push(product);
      }
    }
  }

  // Find company domain with better logic
  async findCompanyDomain(companyName) {
    // Clean company name for domain search
    const searchName = companyName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '');
    
    // Common pharmaceutical company domain patterns
    const domainPatterns = [
      `${searchName}.com`,
      `${searchName}pharma.com`,
      `${searchName}-pharma.com`,
      `${searchName}therapeutics.com`,
      `${searchName}bio.com`,
      `${searchName}biotech.com`,
      `${searchName}med.com`,
      `${searchName}health.com`,
      `${searchName}rx.com`,
      `www.${searchName}.com`
    ];
    
    // For known major pharma companies, use their actual domains
    const knownDomains = {
      'pfizer': 'pfizer.com',
      'merck': 'merck.com',
      'johnson & johnson': 'jnj.com',
      'j&j': 'jnj.com',
      'roche': 'roche.com',
      'novartis': 'novartis.com',
      'sanofi': 'sanofi.com',
      'glaxosmithkline': 'gsk.com',
      'gsk': 'gsk.com',
      'astrazeneca': 'astrazeneca.com',
      'abbvie': 'abbvie.com',
      'bristol myers squibb': 'bms.com',
      'bristol-myers squibb': 'bms.com',
      'bms': 'bms.com',
      'eli lilly': 'lilly.com',
      'lilly': 'lilly.com',
      'amgen': 'amgen.com',
      'gilead': 'gilead.com',
      'biogen': 'biogen.com',
      'regeneron': 'regeneron.com',
      'moderna': 'modernatx.com',
      'bayer': 'bayer.com',
      'takeda': 'takeda.com',
      'boehringer ingelheim': 'boehringer-ingelheim.com',
      'teva': 'tevapharm.com',
      'mylan': 'mylan.com',
      'viatris': 'viatris.com',
      'sun pharma': 'sunpharma.com',
      'sun pharmaceutical': 'sunpharma.com',
      'aurobindo': 'aurobindo.com',
      'aurobindo pharma': 'aurobindo.com',
      'cipla': 'cipla.com',
      'dr reddys': 'drreddys.com',
      'lupin': 'lupin.com',
      'zydus': 'zyduslife.com',
      'abbott': 'abbott.com',
      'allergan': 'allergan.com',
      'vertex': 'vrtx.com',
      'alexion': 'alexion.com',
      'incyte': 'incyte.com',
      'jazz pharmaceuticals': 'jazzpharma.com',
      'horizon therapeutics': 'horizontherapeutics.com',
      'catalent': 'catalent.com',
      'perrigo': 'perrigo.com',
      'mallinckrodt': 'mallinckrodt.com',
      'hikma': 'hikma.com',
      'amneal': 'amneal.com'
    };
    
    // Check if it's a known company
    const searchKey = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (knownDomains[searchKey]) {
      return knownDomains[searchKey];
    }
    
    // Check partial matches for known companies
    for (const [key, domain] of Object.entries(knownDomains)) {
      if (searchKey.includes(key) || key.includes(searchKey)) {
        return domain;
      }
    }
    
    // Return the most likely domain pattern
    return domainPatterns[0];
  }

  // Enhanced contact finding with better company info
  async findContactsForCompany(companyName) {
    if (this.contacts.has(companyName)) {
      return this.contacts.get(companyName);
    }

    const contactInfo = {
      company: companyName,
      domain: null,
      emails: [],
      executives: [],
      regulatory_contacts: [],
      general_email: null,
      phone: null,
      address: null,
      linkedin: null,
      website: null,
      last_updated: new Date().toISOString()
    };

    try {
      // Get proper domain
      const domain = await this.findCompanyDomain(companyName);
      if (domain) {
        contactInfo.domain = domain;
        contactInfo.website = `https://${domain}`;

        // Use Hunter.io to find emails
        if (API_KEYS.HUNTER && API_KEYS.HUNTER !== 'your_hunter_api_key') {
          const hunterData = await this.searchHunter(domain, companyName);
          if (hunterData) {
            contactInfo.emails = hunterData.emails || [];
            contactInfo.general_email = hunterData.general_email;
            contactInfo.phone = hunterData.phone;
            contactInfo.address = hunterData.address;
            contactInfo.linkedin = hunterData.linkedin;
          }
        }

        // Use Apollo.io for more detailed contact info
        if (API_KEYS.APOLLO && API_KEYS.APOLLO !== 'your_apollo_api_key') {
          const apolloData = await this.searchApollo(companyName, domain);
          if (apolloData) {
            contactInfo.executives = apolloData.executives || [];
            contactInfo.regulatory_contacts = apolloData.regulatory_contacts || [];
          }
        }

        // Try Clearbit as fallback
        if (API_KEYS.CLEARBIT && API_KEYS.CLEARBIT !== 'your_clearbit_api_key') {
          const clearbitData = await this.searchClearbit(domain);
          if (clearbitData) {
            contactInfo.phone = contactInfo.phone || clearbitData.phone;
            contactInfo.address = contactInfo.address || clearbitData.address;
          }
        }

        // Generate generic email patterns if no API keys
        if (!API_KEYS.HUNTER || API_KEYS.HUNTER === 'your_hunter_api_key') {
          contactInfo.general_email = `info@${domain}`;
          contactInfo.regulatory_contacts = [
            { 
              name: 'Regulatory Affairs', 
              title: 'Department', 
              email: `regulatory@${domain}` 
            },
            { 
              name: 'Quality Assurance', 
              title: 'Department', 
              email: `quality@${domain}` 
            },
            { 
              name: 'Compliance', 
              title: 'Department', 
              email: `compliance@${domain}` 
            }
          ];
        }
      }
    } catch (error) {
      console.error(`Error finding contacts for ${companyName}:`, error.message);
    }

    this.contacts.set(companyName, contactInfo);
    await this.saveContacts();
    return contactInfo;
  }

  async searchHunter(domain, companyName) {
    try {
      const response = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: {
          domain: domain,
          api_key: API_KEYS.HUNTER
        }
      });

      if (response.data && response.data.data) {
        const data = response.data.data;
        return {
          emails: data.emails.map(e => ({
            email: e.value,
            name: `${e.first_name} ${e.last_name}`.trim(),
            position: e.position,
            department: e.department,
            confidence: e.confidence
          })).filter(e => 
            // Prioritize regulatory/quality contacts
            e.position && (
              e.position.toLowerCase().includes('regulatory') ||
              e.position.toLowerCase().includes('quality') ||
              e.position.toLowerCase().includes('compliance') ||
              e.position.toLowerCase().includes('chief') ||
              e.position.toLowerCase().includes('director')
            )
          ),
          general_email: data.pattern ? data.pattern.replace('{first}', 'info').replace('{last}', '') : null,
          phone: data.phone_number,
          address: data.country,
          linkedin: data.linkedin_url
        };
      }
    } catch (error) {
      console.error('Hunter.io error:', error.message);
    }
    return null;
  }

  async searchApollo(companyName, domain) {
    try {
      const response = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
        api_key: API_KEYS.APOLLO,
        q_organization_domains: domain,
        per_page: 10,
        page: 1,
        person_titles: ['Regulatory', 'Quality', 'Compliance', 'VP', 'Director', 'Chief']
      });

      if (response.data && response.data.people) {
        return {
          executives: response.data.people.filter(p => 
            p.title && (p.title.includes('Chief') || p.title.includes('VP'))
          ).map(p => ({
            name: p.name,
            title: p.title,
            email: p.email,
            linkedin: p.linkedin_url,
            phone: p.phone_numbers?.[0]
          })),
          regulatory_contacts: response.data.people.filter(p => 
            p.title && (
              p.title.toLowerCase().includes('regulatory') ||
              p.title.toLowerCase().includes('quality') ||
              p.title.toLowerCase().includes('compliance')
            )
          ).map(p => ({
            name: p.name,
            title: p.title,
            email: p.email,
            linkedin: p.linkedin_url
          }))
        };
      }
    } catch (error) {
      console.error('Apollo.io error:', error.message);
    }
    return null;
  }

  async searchClearbit(domain) {
    try {
      const response = await axios.get(`https://company.clearbit.com/v2/companies/find`, {
        params: { domain: domain },
        headers: { Authorization: `Bearer ${API_KEYS.CLEARBIT}` }
      });

      if (response.data) {
        return {
          phone: response.data.phone,
          address: `${response.data.location}, ${response.data.country}`,
          employees: response.data.metrics?.employees,
          industry: response.data.category?.industry
        };
      }
    } catch (error) {
      console.error('Clearbit error:', error.message);
    }
    return null;
  }

  getCompanyTimeline(companyName) {
    const company = this.companies.get(this.normalizeCompanyName(companyName));
    if (!company) return null;

    const contacts = this.contacts.get(this.normalizeCompanyName(companyName));

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
      products: company.products,
      contacts: contacts
    };
  }

  async save() {
    const companiesArray = Array.from(this.companies.values());
    await fs.writeFile(COMPANIES_FILE, JSON.stringify(companiesArray, null, 2));
    
    const patternsData = {
      updated: new Date().toISOString(),
      patterns: this.detectPatterns()
    };
    await fs.writeFile(PATTERNS_FILE, JSON.stringify(patternsData, null, 2));
  }

  async saveContacts() {
    const contactsArray = Array.from(this.contacts.values());
    await fs.writeFile(CONTACTS_FILE, JSON.stringify(contactsArray, null, 2));
  }
}

// Enhanced Alert System with Push Notifications
class AlertSystem {
  constructor() {
    this.watchlist = [];
    this.alerts = [];
    this.subscriptions = [];
    this.reportSettings = {
      daily: { enabled: false, time: '09:00', recipients: [] },
      weekly: { enabled: false, day: 'monday', time: '09:00', recipients: [] }
    };
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

    try {
      const subsData = await fs.readFile(SUBSCRIPTIONS_FILE, 'utf8');
      const data = JSON.parse(subsData);
      this.subscriptions = data.subscriptions || [];
      this.reportSettings = data.reportSettings || this.reportSettings;
    } catch {
      // Use defaults
    }
  }

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
        webhook: criteria.webhook || null,
        push: criteria.push !== false
      }
    };

    this.watchlist = this.watchlist.filter(w => w.company !== company);
    this.watchlist.push(entry);
    await this.saveWatchlist();
    return entry;
  }

  async checkAlerts(newItems, companyIntel) {
    const newAlerts = [];

    for (const item of newItems) {
      const companyName = companyIntel.normalizeCompanyName(item.company);
      
      const watchEntry = this.watchlist.find(w => 
        companyIntel.normalizeCompanyName(w.company) === companyName
      );

      if (watchEntry) {
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
            await this.sendEmailAlert(alert, watchEntry.criteria.email, companyIntel);
          }
          if (watchEntry.criteria.webhook) {
            await this.sendWebhookAlert(alert, watchEntry.criteria.webhook);
          }
          if (watchEntry.criteria.push) {
            await this.sendPushNotification(alert);
          }
        }
      }

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
        await this.sendPushNotification(alert);
      }
    }

    if (this.alerts.length > 500) {
      this.alerts = this.alerts.slice(0, 500);
    }

    await this.saveAlerts();
    return newAlerts;
  }

  async sendEmailAlert(alert, email, companyIntel) {
    try {
      const contacts = companyIntel.contacts.get(alert.company);
      
      const mailOptions = {
        from: API_KEYS.SMTP_USER,
        to: email,
        subject: `FDA Alert: ${alert.company} - ${alert.type.replace(/_/g, ' ').toUpperCase()}`,
        html: `
          <h2>FDA Regulatory Alert</h2>
          <p><strong>Company:</strong> ${alert.company}</p>
          <p><strong>Type:</strong> ${alert.type.replace(/_/g, ' ').toUpperCase()}</p>
          <p><strong>Severity:</strong> ${alert.severity}/10</p>
          <p><strong>Date:</strong> ${new Date(alert.date).toLocaleDateString()}</p>
          <p><strong>Title:</strong> ${alert.title}</p>
          <p><strong>Link:</strong> <a href="${alert.link}">${alert.link}</a></p>
          ${alert.summary ? `<p><strong>Summary:</strong> ${alert.summary}</p>` : ''}
          
          ${contacts ? `
            <h3>Company Contact Information:</h3>
            <p><strong>Website:</strong> ${contacts.website || 'N/A'}</p>
            <p><strong>Phone:</strong> ${contacts.phone || 'N/A'}</p>
            ${contacts.regulatory_contacts.length > 0 ? `
              <p><strong>Regulatory Contacts:</strong></p>
              <ul>
                ${contacts.regulatory_contacts.map(c => `
                  <li>${c.name} - ${c.title} (${c.email || 'Email not found'})</li>
                `).join('')}
              </ul>
            ` : ''}
          ` : ''}
        `
      };

      await emailTransporter.sendMail(mailOptions);
      console.log(`Email alert sent to ${email} for ${alert.company}`);
    } catch (error) {
      console.error('Email error:', error.message);
    }
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

  async sendPushNotification(alert) {
    const payload = JSON.stringify({
      title: `FDA Alert: ${alert.company}`,
      body: `${alert.type.replace(/_/g, ' ').toUpperCase()} - ${alert.title}`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        alertId: alert.id,
        company: alert.company,
        link: alert.link
      }
    });

    for (const subscription of this.subscriptions) {
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (error) {
        console.error('Push notification error:', error.message);
        // Remove invalid subscriptions
        if (error.statusCode === 410) {
          this.subscriptions = this.subscriptions.filter(s => s !== subscription);
          await this.saveSubscriptions();
        }
      }
    }
  }

  async generateWeeklyReport(companyIntel) {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const weeklyAlerts = this.alerts.filter(a => 
      new Date(a.created) >= oneWeekAgo
    );

    const patterns = companyIntel.detectPatterns();
    
    const report = {
      id: `report-weekly-${Date.now()}`,
      type: 'weekly',
      period: {
        from: oneWeekAgo.toISOString(),
        to: new Date().toISOString()
      },
      summary: {
        total_alerts: weeklyAlerts.length,
        high_severity: weeklyAlerts.filter(a => a.severity >= 8).length,
        companies_affected: [...new Set(weeklyAlerts.map(a => a.company))].length,
        top_violation_types: this.getTopViolationTypes(weeklyAlerts)
      },
      details: {
        alerts_by_company: this.groupAlertsByCompany(weeklyAlerts),
        hotspots: patterns.hotspots.slice(0, 5),
        escalating: patterns.escalating,
        repeat_offenders: patterns.repeat_offenders.slice(0, 5)
      },
      recommendations: this.generateRecommendations(weeklyAlerts, patterns),
      generated: new Date().toISOString()
    };

    // Save report
    try {
      const reports = JSON.parse(await fs.readFile(REPORTS_FILE, 'utf8').catch(() => '[]'));
      reports.unshift(report);
      if (reports.length > 52) reports = reports.slice(0, 52); // Keep 1 year
      await fs.writeFile(REPORTS_FILE, JSON.stringify(reports, null, 2));
    } catch (error) {
      console.error('Error saving report:', error);
    }

    // Send report email
    if (this.reportSettings.weekly.enabled && this.reportSettings.weekly.recipients.length > 0) {
      await this.sendReportEmail(report, this.reportSettings.weekly.recipients);
    }

    return report;
  }

  async generateDailyReport(companyIntel) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dailyAlerts = this.alerts.filter(a => 
      new Date(a.created) >= yesterday
    );

    const report = {
      id: `report-daily-${Date.now()}`,
      type: 'daily',
      period: {
        from: yesterday.toISOString(),
        to: new Date().toISOString()
      },
      summary: {
        total_alerts: dailyAlerts.length,
        high_severity: dailyAlerts.filter(a => a.severity >= 8).length,
        companies_affected: [...new Set(dailyAlerts.map(a => a.company))].length
      },
      alerts: dailyAlerts.map(a => ({
        company: a.company,
        type: a.type,
        severity: a.severity,
        title: a.title,
        link: a.link
      })),
      generated: new Date().toISOString()
    };

    // Send report
    if (this.reportSettings.daily.enabled && this.reportSettings.daily.recipients.length > 0) {
      await this.sendReportEmail(report, this.reportSettings.daily.recipients);
    }

    return report;
  }

  async sendReportEmail(report, recipients) {
    const subject = report.type === 'weekly' ? 
      'Weekly FDA Regulatory Intelligence Report' : 
      'Daily FDA Regulatory Alert Summary';

    const html = report.type === 'weekly' ? 
      this.generateWeeklyReportHTML(report) : 
      this.generateDailyReportHTML(report);

    try {
      await emailTransporter.sendMail({
        from: API_KEYS.SMTP_USER,
        to: recipients.join(', '),
        subject: subject,
        html: html
      });
      console.log(`${report.type} report sent to ${recipients.length} recipients`);
    } catch (error) {
      console.error('Report email error:', error.message);
    }
  }

  generateWeeklyReportHTML(report) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
          h2 { color: #34495e; margin-top: 25px; }
          .summary { background: #ecf0f1; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .alert-high { color: #e74c3c; font-weight: bold; }
          .alert-medium { color: #f39c12; }
          .company-section { background: #fff; border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .recommendation { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
          table { width: 100%; border-collapse: collapse; margin: 15px 0; }
          th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
          th { background: #3498db; color: white; }
        </style>
      </head>
      <body>
        <h1>Weekly FDA Regulatory Intelligence Report</h1>
        <p>Period: ${new Date(report.period.from).toLocaleDateString()} - ${new Date(report.period.to).toLocaleDateString()}</p>
        
        <div class="summary">
          <h2>Executive Summary</h2>
          <ul>
            <li><strong>Total Alerts:</strong> ${report.summary.total_alerts}</li>
            <li><strong>High Severity:</strong> <span class="alert-high">${report.summary.high_severity}</span></li>
            <li><strong>Companies Affected:</strong> ${report.summary.companies_affected}</li>
            <li><strong>Top Violations:</strong> ${report.summary.top_violation_types.join(', ')}</li>
          </ul>
        </div>

        <h2>Hotspot Companies</h2>
        ${report.details.hotspots.map(h => `
          <div class="company-section">
            <h3>${h.company}</h3>
            <p>${h.count} violations (${h.types.join(', ')})</p>
          </div>
        `).join('')}

        <h2>Escalating Issues</h2>
        ${report.details.escalating.length > 0 ? 
          report.details.escalating.map(e => `
            <p><strong>${e.company}:</strong> ${e.from} → ${e.to}</p>
          `).join('') : 
          '<p>No escalating issues detected this week.</p>'
        }

        <h2>Recommendations</h2>
        ${report.recommendations.map(r => `
          <div class="recommendation">
            <strong>${r.title}:</strong> ${r.description}
          </div>
        `).join('')}

        <hr>
        <p style="color: #7f8c8d; font-size: 12px;">
          This report was automatically generated by the FDA Regulatory Intelligence System.
          For questions or to update your subscription preferences, please contact your administrator.
        </p>
      </body>
      </html>
    `;
  }

  generateDailyReportHTML(report) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          h1 { color: #2c3e50; }
          .summary { background: #ecf0f1; padding: 15px; border-radius: 5px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
          th { background: #3498db; color: white; }
          .severity-high { color: #e74c3c; font-weight: bold; }
          .severity-medium { color: #f39c12; }
        </style>
      </head>
      <body>
        <h1>Daily FDA Regulatory Alert Summary</h1>
        <p>Date: ${new Date().toLocaleDateString()}</p>
        
        <div class="summary">
          <p><strong>Total Alerts:</strong> ${report.summary.total_alerts}</p>
          <p><strong>High Severity:</strong> ${report.summary.high_severity}</p>
          <p><strong>Companies Affected:</strong> ${report.summary.companies_affected}</p>
        </div>

        ${report.alerts.length > 0 ? `
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Title</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              ${report.alerts.map(a => `
                <tr>
                  <td>${a.company}</td>
                  <td>${a.type.replace(/_/g, ' ')}</td>
                  <td class="${a.severity >= 8 ? 'severity-high' : a.severity >= 5 ? 'severity-medium' : ''}">${a.severity}/10</td>
                  <td>${a.title}</td>
                  <td><a href="${a.link}">View</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<p>No new alerts in the past 24 hours.</p>'}
      </body>
      </html>
    `;
  }

  getTopViolationTypes(alerts) {
    const types = {};
    alerts.forEach(a => {
      types[a.type] = (types[a.type] || 0) + 1;
    });
    return Object.entries(types)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type.replace(/_/g, ' '));
  }

  groupAlertsByCompany(alerts) {
    const grouped = {};
    alerts.forEach(a => {
      if (!grouped[a.company]) {
        grouped[a.company] = [];
      }
      grouped[a.company].push(a);
    });
    return grouped;
  }

  generateRecommendations(alerts, patterns) {
    const recommendations = [];

    if (patterns.escalating.length > 0) {
      recommendations.push({
        title: 'Escalating Compliance Issues',
        description: `${patterns.escalating.length} companies show escalating violation severity. Consider proactive outreach to these companies.`
      });
    }

    if (patterns.repeat_offenders.length > 2) {
      recommendations.push({
        title: 'Repeat Offender Pattern',
        description: `${patterns.repeat_offenders.length} companies have 3+ violations. These companies may benefit from comprehensive compliance consulting.`
      });
    }

    const highSeverityCount = alerts.filter(a => a.severity >= 8).length;
    if (highSeverityCount > 5) {
      recommendations.push({
        title: 'High Severity Alert Spike',
        description: `${highSeverityCount} high-severity alerts this period. Review for industry-wide compliance trends.`
      });
    }

    return recommendations;
  }

  async saveWatchlist() {
    await fs.writeFile(WATCHLIST_FILE, JSON.stringify(this.watchlist, null, 2));
  }

  async saveAlerts() {
    await fs.writeFile(ALERTS_FILE, JSON.stringify(this.alerts, null, 2));
  }

  async saveSubscriptions() {
    const data = {
      subscriptions: this.subscriptions,
      reportSettings: this.reportSettings
    };
    await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2));
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
      LETTERS_FILE, CRL_FILE, FORM_483_FILE, ALL_ITEMS_FILE, CONTACTS_FILE, 
      REPORTS_FILE, SUBSCRIPTIONS_FILE
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

// Classification function (keeping original)
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

// Fetch functions (keeping original)
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

async function aggregateAllSources() {
  console.log('\n🔄 Starting intelligent aggregation...\n');
  const allItems = [];
  const startTime = Date.now();
  
  const warningLetters = await scrapeFDAWarningLetters();
  allItems.push(...warningLetters);
  
  const allFeeds = [
    ...FEED_SOURCES.fda_official,
    ...FEED_SOURCES.trade_press,
    ...FEED_SOURCES.google_news
  ];
  
  alertSystem.watchlist.forEach(watch => {
    const ticker = watch.ticker;
    if (ticker) {
      allFeeds.push({
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=8-K&output=atom`,
        name: `SEC 8-K - ${watch.company}`,
        category: 'sec',
        priority: 2
      });
    }
  });
  
  const batchSize = 5;
  for (let i = 0; i < allFeeds.length; i += batchSize) {
    const batch = allFeeds.slice(i, i + batchSize);
    const promises = batch.map(source => fetchFeed(source));
    const results = await Promise.all(promises);
    results.forEach(items => allItems.push(...items));
  }
  
  const uniqueItems = [];
  const seenLinks = new Set();
  const newViolations = [];
  
  allItems.forEach(item => {
    const cleanLink = item.link.replace(/[?#].*$/, '').toLowerCase();
    
    if (!seenLinks.has(cleanLink)) {
      seenLinks.add(cleanLink);
      uniqueItems.push(item);
      
      const isNew = companyIntel.updateCompany(item);
      if (isNew) {
        newViolations.push(item);
      }
    }
  });
  
  uniqueItems.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    return new Date(b.date) - new Date(a.date);
  });
  
  const newAlerts = await alertSystem.checkAlerts(newViolations, companyIntel);
  const patterns = companyIntel.detectPatterns();
  
  await fs.writeFile(ALL_ITEMS_FILE, JSON.stringify(uniqueItems, null, 2));
  await companyIntel.save();
  
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

// Enhanced API Routes

// Get company contacts
app.get('/api/companies/:name/contacts', async (req, res) => {
  try {
    const companyName = companyIntel.normalizeCompanyName(req.params.name);
    let contacts = companyIntel.contacts.get(companyName);
    
    if (!contacts) {
      // Try to find contacts
      contacts = await companyIntel.findContactsForCompany(companyName);
    }
    
    res.json({
      success: true,
      contacts: contacts
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Subscribe to push notifications
app.post('/api/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    
    if (!alertSystem.subscriptions.some(s => s.endpoint === subscription.endpoint)) {
      alertSystem.subscriptions.push(subscription);
      await alertSystem.saveSubscriptions();
    }
    
    res.json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update report settings
app.post('/api/report-settings', async (req, res) => {
  try {
    const { frequency, settings } = req.body;
    
    if (frequency === 'daily') {
      alertSystem.reportSettings.daily = {
        ...alertSystem.reportSettings.daily,
        ...settings
      };
    } else if (frequency === 'weekly') {
      alertSystem.reportSettings.weekly = {
        ...alertSystem.reportSettings.weekly,
        ...settings
      };
    }
    
    await alertSystem.saveSubscriptions();
    
    res.json({
      success: true,
      message: `${frequency} report settings updated`,
      settings: alertSystem.reportSettings
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get reports
app.get('/api/reports', async (req, res) => {
  try {
    const reports = JSON.parse(await fs.readFile(REPORTS_FILE, 'utf8').catch(() => '[]'));
    res.json({
      success: true,
      count: reports.length,
      reports: reports.slice(0, 20)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate report on demand
app.post('/api/reports/generate', async (req, res) => {
  try {
    const { type = 'weekly' } = req.body;
    
    const report = type === 'weekly' ? 
      await alertSystem.generateWeeklyReport(companyIntel) :
      await alertSystem.generateDailyReport(companyIntel);
    
    res.json({
      success: true,
      report: report
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export contacts for outreach
app.get('/api/export/contacts', async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    const contacts = Array.from(companyIntel.contacts.values());
    
    if (format === 'csv') {
      const csv = [
        'Company,Domain,Website,Phone,Address,Regulatory Contacts,Executive Contacts',
        ...contacts.map(c => {
          const regContacts = c.regulatory_contacts.map(rc => 
            `${rc.name} (${rc.title}) - ${rc.email || 'N/A'}`
          ).join('; ');
          const execContacts = c.executives.map(ec => 
            `${ec.name} (${ec.title}) - ${ec.email || 'N/A'}`
          ).join('; ');
          return `"${c.company}","${c.domain || ''}","${c.website || ''}","${c.phone || ''}","${c.address || ''}","${regContacts}","${execContacts}"`;
        })
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="fda-contacts.csv"');
      res.send(csv);
    } else {
      res.json({
        success: true,
        count: contacts.length,
        contacts: contacts
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// All previous API routes remain the same...
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

// Continuation of server-enhanced.js API routes

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

app.get('/api/insights', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));
    
    const allData = await fs.readFile(ALL_ITEMS_FILE, 'utf8');
    const items = JSON.parse(allData);
    const recentItems = items.filter(i => new Date(i.date) >= cutoff);
    
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
    
    recentItems.forEach(item => {
      item.types.forEach(type => {
        insights.by_type[type] = (insights.by_type[type] || 0) + 1;
      });
    });
    
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

// Schedule automated reports
function setupScheduledTasks() {
  // Daily report at 9 AM
  cron.schedule('0 9 * * *', async () => {
    if (alertSystem.reportSettings.daily.enabled) {
      console.log('Generating daily report...');
      await alertSystem.generateDailyReport(companyIntel);
    }
  });

  // Weekly report on Mondays at 9 AM
  cron.schedule('0 9 * * 1', async () => {
    if (alertSystem.reportSettings.weekly.enabled) {
      console.log('Generating weekly report...');
      await alertSystem.generateWeeklyReport(companyIntel);
    }
  });

  // Data refresh every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('\n⏰ Scheduled intelligence refresh...');
    await aggregateAllSources();
  });
}

// Start server
async function start() {
  await initStorage();
  
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🏥 FDA Regulatory Intelligence System v3.0');
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
    console.log('  • Contact finding (Hunter.io/Apollo)');
    console.log('  • Automated reporting');
    console.log('  • Push notifications');
    console.log('  • Email outreach data');
    console.log('\n🔑 API Keys Status:');
    console.log(`  • Hunter.io: ${API_KEYS.HUNTER !== 'your_hunter_api_key' ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`  • Apollo.io: ${API_KEYS.APOLLO !== 'your_apollo_api_key' ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`  • Clearbit: ${API_KEYS.CLEARBIT !== 'your_clearbit_api_key' ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`  • Email: ${API_KEYS.SMTP_USER !== 'your_email@gmail.com' ? '✓ Configured' : '✗ Not configured'}`);
    console.log('\n🔄 Initializing intelligence systems...\n');
  });
  
  // Initial data fetch
  const stats = await aggregateAllSources();
  
  // Setup scheduled tasks
  setupScheduledTasks();
  
  console.log('\n✨ Intelligence system ready!');
  console.log('='.repeat(60) + '\n');
}

// Export for testing
module.exports = {
  app,
  companyIntel,
  alertSystem,
  aggregateAllSources
};

// Run if main module
if (require.main === module) {
  start();
}