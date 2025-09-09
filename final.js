// server-complete.js - Full FDA Regulatory Intelligence Platform v5.0
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
const mongoose = require('mongoose');
const OpenAI = require('openai');
const stringSimilarity = require('string-similarity');
const moment = require('moment-timezone');
const crypto = require('crypto');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'FDA-Monitor/5.0' }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Environment Configuration
require('dotenv').config();

// MongoDB Connection with retry logic
const connectDB = async () => {
  const maxRetries = 5;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await mongoose.connect(process.env.MONGO_URI || '', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('✅ MongoDB connected successfully');
      return;
    } catch (error) {
      retries++;
      console.error(`MongoDB connection attempt ${retries} failed:`, error.message);
      if (retries === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

// Enhanced WLUSERLEAF Schema with additional fields
const wluserleafSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, auto: true },
  email: { 
    type: String, 
    required: true, 
    unique: true,
    validate: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  firstName: { type: String },
  lastName: { type: String },
  company: { type: String },
  role: { type: String },
  notificationPrefs: {
    instant: { type: Boolean, default: true },
    weekly: { type: Boolean, default: true },
    daily: { type: Boolean, default: false },
    criticalOnly: { type: Boolean, default: false }
  },
  digestDayOfWeek: { type: Number, default: 1, min: 0, max: 6 },
  digestHour: { type: Number, default: 9, min: 0, max: 23 },
  timezone: { type: String, default: 'Europe/London' },
  reportEmails: [{ 
    type: String,
    validate: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  }],
  watchedCompanies: [{
    name: String,
    addedAt: Date,
    alertLevel: { type: String, enum: ['all', 'critical', 'custom'] },
    customRules: Object
  }],
  apiKeys: {
    hunter: { type: String, select: false },
    apollo: { type: String, select: false }
  },
  preferences: {
    theme: { type: String, default: 'light' },
    dashboardLayout: { type: String, default: 'default' },
    itemsPerPage: { type: Number, default: 50 },
    autoRefresh: { type: Boolean, default: true },
    refreshInterval: { type: Number, default: 30 }
  },
  lastLogin: { type: Date },
  loginCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Add indexes for performance
wluserleafSchema.index({ email: 1 });
wluserleafSchema.index({ 'watchedCompanies.name': 1 });
wluserleafSchema.index({ createdAt: -1 });

const WLUserLeaf = mongoose.model('WLUserLeaf', wluserleafSchema);

// Audit Log Schema for compliance tracking
const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'WLUserLeaf' },
  action: { type: String, required: true },
  details: Object,
  ipAddress: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now }
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

// Enhanced Data Storage Paths
const DATA_DIR = './data';
const CACHE_DIR = './cache';
const BACKUP_DIR = './backups';

// Ensure directories exist
const ensureDirectories = async () => {
  for (const dir of [DATA_DIR, CACHE_DIR, BACKUP_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
};

// Data files
const DATA_FILES = {
  COMPANIES: path.join(DATA_DIR, 'companies.json'),
  ALERTS: path.join(DATA_DIR, 'alerts.json'),
  WATCHLIST: path.join(DATA_DIR, 'watchlist.json'),
  TIMELINE: path.join(DATA_DIR, 'timeline.json'),
  PATTERNS: path.join(DATA_DIR, 'patterns.json'),
  CONTACTS: path.join(DATA_DIR, 'contacts.json'),
  REPORTS: path.join(DATA_DIR, 'reports.json'),
  SUBSCRIPTIONS: path.join(DATA_DIR, 'subscriptions.json'),
  WARNING_LETTERS: path.join(DATA_DIR, 'warning_letters.json'),
  CRL_LETTERS: path.join(DATA_DIR, 'crl_letters.json'),
  FORM_483: path.join(DATA_DIR, 'form_483.json'),
  ALL_ITEMS: path.join(DATA_DIR, 'all_items.json'),
  AI_CACHE: path.join(CACHE_DIR, 'ai_cache.json'),
  COMPANY_CACHE: path.join(CACHE_DIR, 'company_cache.json'),
  METRICS: path.join(DATA_DIR, 'metrics.json')
};

// API Keys Configuration
const API_KEYS = {
  HUNTER: process.env.HUNTER_API_KEY,
  APOLLO: process.env.APOLLO_API_KEY ,
  CLEARBIT: process.env.CLEARBIT_API_KEY,
  OPENAI: process.env.OPENAI_API_KEY,
  OPENAI_ASSISTANT: process.env.OPENAI_ASSISTANT_ID,
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_USER: process.env.SMTP_USER ,
  SMTP_PASS: process.env.SMTP_PASS,
    VAPID_PUBLIC: process.env.VAPID_PUBLIC ,
  VAPID_PRIVATE: process.env.VAPID_PRIVATE ,
  SEC_API: process.env.SEC_API_KEY,
  NEWS_API: process.env.NEWS_API_KEY
};

// Initialize OpenAI with error handling
let openai = null;
if (API_KEYS.OPENAI) {
  try {
    openai = new OpenAI({ apiKey: API_KEYS.OPENAI });
    console.log('✅ OpenAI initialized');
  } catch (error) {
    console.error('❌ OpenAI initialization failed:', error.message);
  }
}

// Configure push notifications
if (API_KEYS.VAPID_PUBLIC && API_KEYS.VAPID_PRIVATE) {
  webpush.setVapidDetails(
    'mailto:' + API_KEYS.SMTP_USER,
    API_KEYS.VAPID_PUBLIC,
    API_KEYS.VAPID_PRIVATE
  );
  console.log('✅ Push notifications configured');
}

// Enhanced email transporter with better error handling
let emailTransporter = null;
if (API_KEYS.SMTP_USER && API_KEYS.SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: API_KEYS.SMTP_HOST,
    port: API_KEYS.SMTP_PORT,
    secure: API_KEYS.SMTP_PORT === 465,
    auth: {
      user: API_KEYS.SMTP_USER,
      pass: API_KEYS.SMTP_PASS
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });
  
  emailTransporter.verify((error, success) => {
    if (error) {
      console.error('❌ Email configuration error:', error.message);
    } else {
      console.log('✅ Email server ready');
    }
  });
}

// Comprehensive Feed Sources - All data sources from your files
// const FEED_SOURCES = {
//   fda_official: [
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
//       name: 'FDA Press Announcements',
//       category: 'official',
//       priority: 1,
//       type: 'general'
//     },
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/whats-new-drugs/rss.xml',
//       name: 'FDA CDER Updates',
//       category: 'official',
//       priority: 1,
//       type: 'drugs'
//     },
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml',
//       name: 'FDA MedWatch Safety',
//       category: 'official',
//       priority: 1,
//       type: 'safety'
//     },
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/warning-letters/rss.xml',
//       name: 'FDA Warning Letters RSS',
//       category: 'official',
//       priority: 1,
//       type: 'warning_letter'
//     },
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/biologics/rss.xml',
//       name: 'FDA CBER Biologics',
//       category: 'official',
//       priority: 1,
//       type: 'biologics'
//     },
//     {
//       url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/devices/rss.xml',
//       name: 'FDA CDRH Devices',
//       category: 'official',
//       priority: 1,
//       type: 'devices'
//     }
//   ],
  
//   trade_press: [
//     {
//       url: 'https://www.fiercepharma.com/rss/xml',
//       name: 'FiercePharma',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.fiercebiotech.com/rss/xml',
//       name: 'FierceBiotech',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.statnews.com/category/pharma/feed/',
//       name: 'STAT News Pharma',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.statnews.com/category/biotech/feed/',
//       name: 'STAT News Biotech',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.biospace.com/rss',
//       name: 'BioSpace',
//       category: 'trade',
//       priority: 3
//     },
//     {
//       url: 'https://www.raps.org/rss/regulatory-focus',
//       name: 'RAPS Regulatory Focus',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.biopharmadive.com/feeds/news/',
//       name: 'BioPharma Dive',
//       category: 'trade',
//       priority: 3
//     },
//     {
//       url: 'https://endpts.com/feed/',
//       name: 'Endpoints News',
//       category: 'trade',
//       priority: 2
//     },
//     {
//       url: 'https://www.pharmavoice.com/rss/',
//       name: 'PharmaVoice',
//       category: 'trade',
//       priority: 3
//     }
//   ],
  
//   google_news: [
//     {
//       url: 'https://news.google.com/rss/search?q=%22Complete%20Response%20Letter%22%20FDA&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - CRLs',
//       category: 'google',
//       type: 'crl',
//       priority: 3
//     },
//     {
//       url: 'https://news.google.com/rss/search?q=site%3Afda.gov%20%22Warning%20Letters%22&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - FDA Warning Letters',
//       category: 'google',
//       type: 'warning_letter',
//       priority: 3
//     },
//     {
//       url: 'https://news.google.com/rss/search?q=site%3Afda.gov%20OPDP%20%28%22Untitled%20Letter%22%20OR%20%22Warning%20Letter%22%29&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - OPDP Letters',
//       category: 'google',
//       type: 'opdp',
//       priority: 3
//     },
//     {
//       url: 'https://news.google.com/rss/search?q=FDA%20%22Form%20483%22%20observations&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - Form 483',
//       category: 'google',
//       type: 'form_483',
//       priority: 3
//     },
//     {
//       url: 'https://news.google.com/rss/search?q=%22Import%20Alert%22%20FDA%20pharmaceutical&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - Import Alerts',
//       category: 'google',
//       type: 'import_alert',
//       priority: 3
//     },
//     {
//       url: 'https://news.google.com/rss/search?q=%22Consent%20Decree%22%20FDA%20pharmaceutical&hl=en-US&gl=US&ceid=US:en',
//       name: 'Google News - Consent Decrees',
//       category: 'google',
//       type: 'consent_decree',
//       priority: 3
//     }
//   ],
  
//   sec_filings: [] // Dynamically populated based on watched companies
// };
const FEED_SOURCES = {
  fda_official: [
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
      name: 'FDA Press Announcements',
      category: 'official',
      priority: 1,
      type: 'general'
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml',
      name: 'FDA CDER Updates',
      category: 'official',
      priority: 1,
      type: 'drugs'
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml',
      name: 'FDA MedWatch Safety',
      category: 'official',
      priority: 1,
      type: 'safety'
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/ora-foia-electronic-reading-room/rss.xml',
      name: 'FDA OII FOIA Electronic Reading Room',
      category: 'official',
      priority: 1,
      type: 'foia'
    },
    {
      url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/biologics/rss.xml',
      name: 'FDA CBER Biologics',
      category: 'official',
      priority: 1,
      type: 'biologics'
    },
    {
      url: 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma-rss.cfm',
      name: 'FDA CDRH Devices',
      category: 'official',
      priority: 1,
      type: 'devices'
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
      url: 'https://www.statnews.com/category/biotech/feed/',
      name: 'STAT News Biotech',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.biospace.com/FDA.rss',
      name: 'BioSpace',
      category: 'trade',
      priority: 3
    },
    {
      url: 'https://www.raps.org/news-and-articles?rss=Regulatory-Focus',
      name: 'RAPS Regulatory Focus',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.biopharmadive.com/feeds/news/',
      name: 'BioPharma Dive',
      category: 'trade',
      priority: 3
    },
    {
      url: 'https://endpts.com/feed/',
      name: 'Endpoints News',
      category: 'trade',
      priority: 2
    },
    {
      url: 'https://www.pharmavoice.com/feeds/news',
      name: 'PharmaVoice',
      category: 'trade',
      priority: 3
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
      url: 'https://news.google.com/rss/search?q=site%3Afda.gov%20%22Warning%20Letters%22&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - FDA Warning Letters',
      category: 'google',
      type: 'foia',
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
      type: 'form_483',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=%22Import%20Alert%22%20FDA%20pharmaceutical&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - Import Alerts',
      category: 'google',
      type: 'import_alert',
      priority: 3
    },
    {
      url: 'https://news.google.com/rss/search?q=%22Consent%20Decree%22%20FDA%20pharmaceutical&hl=en-US&gl=US&ceid=US:en',
      name: 'Google News - Consent Decrees',
      category: 'google',
      type: 'consent_decree',
      priority: 3
    }
  ],
  
  sec_filings: [] // Dynamically populated based on watched companies
};
// Enhanced Classification System with more detail
const CLASSIFIERS = {
  warning_letter: {
    keywords: ['warning letter', 'FDA warns', 'regulatory warning', 'untitled letter'],
    severity: 8,
    impact: 'high',
    typical_timeline: '15 days to respond',
    regulatory_impact: 'May affect product approval, manufacturing',
    business_impact: 'Stock impact, reputation risk',
    color: '#dc2626',
    icon: '⚠️'
  },
  crl: {
    keywords: ['complete response letter', 'CRL', 'FDA rejects', 'approval denial', 'deficiency letter'],
    severity: 9,
    impact: 'critical',
    typical_timeline: 'Resubmission in 6+ months',
    regulatory_impact: 'Product approval delayed/denied',
    business_impact: 'Major stock impact, revenue delay',
    color: '#7c2d12',
    icon: '🚫'
  },
  form_483: {
    keywords: ['form 483', '483 observations', 'inspection observations', 'FDA inspection'],
    severity: 6,
    impact: 'medium',
    typical_timeline: '15 days to respond',
    regulatory_impact: 'Manufacturing concerns identified',
    business_impact: 'Potential warning letter if not addressed',
    color: '#ea580c',
    icon: '📋'
  },
  opdp: {
    keywords: ['OPDP', 'untitled letter', 'promotional', 'misleading claims', 'false advertising'],
    severity: 5,
    impact: 'medium',
    typical_timeline: '14 days to respond',
    regulatory_impact: 'Marketing materials must be revised',
    business_impact: 'Marketing campaign disruption',
    color: '#0891b2',
    icon: '📢'
  },
  import_alert: {
    keywords: ['import alert', 'DWPE', 'detention without physical examination', 'import ban'],
    severity: 7,
    impact: 'high',
    typical_timeline: 'Immediate',
    regulatory_impact: 'Products blocked at border',
    business_impact: 'Supply chain disruption',
    color: '#dc2626',
    icon: '🚫'
  },
  consent_decree: {
    keywords: ['consent decree', 'permanent injunction', 'court order'],
    severity: 10,
    impact: 'critical',
    typical_timeline: 'Ongoing compliance',
    regulatory_impact: 'Court-ordered compliance',
    business_impact: 'Severe operational restrictions',
    color: '#991b1b',
    icon: '⚖️'
  },
  recall: {
    keywords: ['recall', 'voluntary recall', 'market withdrawal', 'safety alert'],
    severity: 7,
    impact: 'high',
    typical_timeline: 'Immediate',
    regulatory_impact: 'Product removal required',
    business_impact: 'Revenue loss, liability risk',
    color: '#dc2626',
    icon: '🔄'
  },
  clinical_hold: {
    keywords: ['clinical hold', 'study halt', 'trial suspension'],
    severity: 8,
    impact: 'high',
    typical_timeline: 'Variable',
    regulatory_impact: 'Clinical trials stopped',
    business_impact: 'Development timeline delay',
    color: '#dc2626',
    icon: '⏸️'
  }
};

// Advanced Company Intelligence System
// COMPLETE REPLACEMENT FOR CompanyIntelligenceSystem class in final.js

class CompanyIntelligenceSystem {
  constructor() {
    this.companies = new Map();
    this.companyAliases = new Map();
    this.companyDomains = new Map();
    this.contacts = new Map();
    this.aiCache = new Map();
    this.matchingCache = new Map();
    this.metrics = {
      totalCompanies: 0,
      totalViolations: 0,
      averageResponseTime: 0,
      topViolators: []
    };
    this.initializeKnownCompanies();
  }
  // Add this method to the CompanyIntelligenceSystem class (add it after the findContactsForCompany method)

async updateCompany(item) {
  const companyName = item.company === 'TBD' ? 'Unknown Company' : item.company;
  
  if (!this.companies.has(companyName)) {
    this.companies.set(companyName, {
      name: companyName,
      aliases: [],
      violations: [],
      products: [],
      facilities: [],
      executives: [],
      risk_score: 0,
      compliance_score: 100,
      response_times: [],
      last_updated: new Date().toISOString(),
      first_seen: new Date().toISOString()
    });
  }

  const company = this.companies.get(companyName);
  
  // Create violation record
  const violation = {
    id: item.id,
    type: item.types[0],
    date: item.date,
    title: item.title,
    link: item.link,
    source: item.source,
    summary: item.summary,
    severity: item.severity || 5,
    status: 'new'
  };
  
  // Check if violation already exists
  const exists = company.violations.some(v => v.link === violation.link);
  if (!exists) {
    company.violations.push(violation);
    company.violations.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Keep only last 100 violations
    if (company.violations.length > 100) {
      company.violations = company.violations.slice(0, 100);
    }
    
    company.last_updated = new Date().toISOString();
    
    this.updateMetrics();
    return true;
  }
  
  return false;
}

calculateRiskScore(company) {
  let score = 0;
  const weights = {
    violation_count: 0.3,
    severity: 0.3,
    frequency: 0.2,
    response_time: 0.1,
    repeat_violations: 0.1
  };
  
  // Recent violations (last 2 years)
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const recentViolations = company.violations.filter(v => 
    new Date(v.date) > twoYearsAgo
  );
  
  // Violation count score
  score += Math.min(recentViolations.length * 10, 30) * weights.violation_count;
  
  // Severity score
  const avgSeverity = recentViolations.reduce((sum, v) => sum + (v.severity || 5), 0) / 
                     (recentViolations.length || 1);
  score += avgSeverity * 10 * weights.severity;
  
  // Frequency score (violations per month)
  if (recentViolations.length > 0) {
    const monthsActive = Math.max(1, 
      (Date.now() - new Date(company.first_seen)) / (30 * 24 * 60 * 60 * 1000)
    );
    const frequency = recentViolations.length / monthsActive;
    score += Math.min(frequency * 50, 20) * weights.frequency;
  }
  
  return Math.min(100, Math.round(score));
}

calculateComplianceScore(company) {
  // Inverse of risk score with adjustments
  let score = 100;
  
  const recentViolations = company.violations.filter(v => {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    return new Date(v.date) > sixMonthsAgo;
  });
  
  // Deduct points for recent violations
  score -= recentViolations.length * 5;
  
  // Deduct for high severity violations
  recentViolations.forEach(v => {
    if (v.severity >= 8) score -= 10;
    else if (v.severity >= 6) score -= 5;
  });
  
  // Bonus for clean recent record
  if (recentViolations.length === 0) {
    score = Math.min(100, score + 10);
  }
  
  return Math.max(0, Math.round(score));
}

titleCase(str) {
  return str.replace(/\w\S*/g, txt => 
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

// Add this property at the end of the class

  initializeKnownCompanies() {
    // Major pharmaceutical companies with correct domains
    this.knownCompanies = {
      'pfizer': { canonical: 'Pfizer Inc.', domain: 'pfizer.com', ticker: 'PFE' },
      'merck': { canonical: 'Merck & Co., Inc.', domain: 'merck.com', ticker: 'MRK' },
      'johnson & johnson': { canonical: 'Johnson & Johnson', domain: 'jnj.com', ticker: 'JNJ' },
      'j&j': { canonical: 'Johnson & Johnson', domain: 'jnj.com', ticker: 'JNJ' },
      'roche': { canonical: 'F. Hoffmann-La Roche Ltd', domain: 'roche.com', ticker: 'RHHBY' },
      'novartis': { canonical: 'Novartis AG', domain: 'novartis.com', ticker: 'NVS' },
      'sanofi': { canonical: 'Sanofi', domain: 'sanofi.com', ticker: 'SNY' },
      'glaxosmithkline': { canonical: 'GlaxoSmithKline plc', domain: 'gsk.com', ticker: 'GSK' },
      'gsk': { canonical: 'GlaxoSmithKline plc', domain: 'gsk.com', ticker: 'GSK' },
      'astrazeneca': { canonical: 'AstraZeneca PLC', domain: 'astrazeneca.com', ticker: 'AZN' },
      'abbvie': { canonical: 'AbbVie Inc.', domain: 'abbvie.com', ticker: 'ABBV' },
      'bristol myers squibb': { canonical: 'Bristol Myers Squibb Company', domain: 'bms.com', ticker: 'BMY' },
      'eli lilly': { canonical: 'Eli Lilly and Company', domain: 'lilly.com', ticker: 'LLY' },
      'amgen': { canonical: 'Amgen Inc.', domain: 'amgen.com', ticker: 'AMGN' },
      'gilead': { canonical: 'Gilead Sciences, Inc.', domain: 'gilead.com', ticker: 'GILD' },
      'biogen': { canonical: 'Biogen Inc.', domain: 'biogen.com', ticker: 'BIIB' },
      'moderna': { canonical: 'Moderna, Inc.', domain: 'modernatx.com', ticker: 'MRNA' }
    };
  }

  async initialize() {
    try {
      // Load existing company data
      const companiesData = await this.loadJSONFile(DATA_FILES.COMPANIES);
      if (companiesData) {
        companiesData.forEach(c => {
          this.companies.set(c.name, c);
          if (c.aliases) {
            c.aliases.forEach(alias => {
              this.companyAliases.set(this.normalizeForMatching(alias), c.name);
            });
          }
        });
      }

      // Load contacts
      const contactsData = await this.loadJSONFile(DATA_FILES.CONTACTS);
      if (contactsData) {
        contactsData.forEach(c => this.contacts.set(c.company, c));
      }

      // Load AI cache
      const aiCacheData = await this.loadJSONFile(DATA_FILES.AI_CACHE);
      if (aiCacheData) {
        Object.entries(aiCacheData).forEach(([key, value]) => {
          this.aiCache.set(key, value);
        });
      }

      this.updateMetrics();
      console.log(`✅ Company Intelligence initialized: ${this.companies.size} companies tracked`);
    } catch (error) {
      console.error('Company Intelligence initialization error:', error);
    }
  }

  async loadJSONFile(filepath) {
    try {
      const data = await fs.readFile(filepath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  normalizeForMatching(name) {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // SIMPLIFIED: Just return placeholder for initial display
  extractCompanyName(title, content, link, source) {
    // Don't try to extract - let AI do it when modal opens
    return "TBD";
  }

  findCanonicalName(name) {
    if (!name || name === 'TBD' || name === 'Unknown Company') return name;
    
    const normalized = this.normalizeForMatching(name);
    
    // Check known companies
    if (this.knownCompanies[normalized]) {
      return this.knownCompanies[normalized].canonical;
    }
    
    // Check aliases
    if (this.companyAliases.has(normalized)) {
      return this.companyAliases.get(normalized);
    }
    
    return name;
  }

  async findCompanyDomain(companyName) {
    const normalized = this.normalizeForMatching(companyName);
    
    // Check known companies first
    if (this.knownCompanies[normalized]) {
      return this.knownCompanies[normalized].domain;
    }
    
    // Check cache
    if (this.companyDomains.has(companyName)) {
      return this.companyDomains.get(companyName);
    }
    
    // Generate likely domain
    const searchName = companyName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '');
    
    const domain = `${searchName}.com`;
    this.companyDomains.set(companyName, domain);
    
    return domain;
  }

  async searchHunter(domain, companyName) {
    try {
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        console.warn(`Invalid domain for Hunter: ${domain}`);
        return null;
      }

      console.log(`🔍 Searching Hunter for ${companyName} (${domain})`);

      const response = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: {
          domain: domain,
          api_key: API_KEYS.HUNTER,
          limit: 10
        },
        timeout: 15000
      });

      if (response.data && response.data.data) {
        const data = response.data.data;
        console.log(`✅ Hunter found ${data.emails?.length || 0} emails for ${domain}`);
        
        return {
          emails: (data.emails || []).map(e => ({
            email: e.value,
            name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
            position: e.position,
            department: e.department,
            confidence: e.confidence
          })),
          pattern: data.pattern,
          domain: domain
        };
      }
    } catch (error) {
      console.error('Hunter error:', error.response?.data || error.message);
    }
    return null;
  }
// Enhanced Apollo Integration - Replace your existing searchApollo and revealApolloEmail functions with these


// Fixed Apollo Integration - Replace your searchApollo function with this

async searchApollo(companyName, domain) {
  const searchAttempts = [];
  let finalResult = null;
  const REVEAL_LIMIT = 10; // Limit reveals to control credit usage

  // Helper function to clean company names
  const cleanCompanyName = (name) => {
    if (!name || typeof name !== 'string') return '';
    return name
      .replace(/,?\s*(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|group|holdings|international|global|usa|america|us|technologies|tech|solutions|services|systems|software|digital|media|partners|ventures|capital|labs|studio|works|industries|enterprises)\.?$/gi, '')
      .replace(/[^\w\s&-]/g, '')
      .replace(/\s+\d{2,4}$/g, '')
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  // Main search function
  const executeApolloSearch = async (searchParams, attemptDescription) => {
    try {
      console.log(`🔍 Apollo attempt: ${attemptDescription}`);
      console.log('   Parameters:', JSON.stringify(searchParams, null, 2));

      const response = await axios.post(
        'https://api.apollo.io/v1/mixed_people/search',
        {
          per_page: 25,
          page: 1,
          ...searchParams
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': API_KEYS.APOLLO,
            'Cache-Control': 'no-cache'
          },
          timeout: 20000
        }
      );

      if (response.data?.people?.length > 0) {
        console.log(`✅ Found ${response.data.people.length} contacts via ${attemptDescription}`);
        
        // Map initial contacts (most won't have emails yet)
        let contacts = response.data.people.map(p => ({
          id: p.id,
          name: p.name,
          title: p.title,
          email: p.email || null,
          phone: p.phone_number || null,
          linkedin: p.linkedin_url,
          verified: p.email_status === 'verified',
          email_status: p.email_status || null,
          company: p.organization?.name,
          domain: p.organization?.primary_domain || p.organization?.domain,
          seniority: p.seniority,
          departments: p.departments,
          locked: !p.email // Mark as locked if no email
        }));

        // Count how many already have emails
        const withEmails = contacts.filter(c => c.email).length;
        console.log(`   📧 ${withEmails} contacts already have emails`);
        console.log(`   🔒 ${contacts.length - withEmails} contacts need enrichment`);

        // CRITICAL: Actually enrich the contacts without emails
        const contactsNeedingEnrichment = contacts.filter(c => !c.email && c.id);
        
        if (contactsNeedingEnrichment.length > 0) {
          console.log(`\n🔓 Starting enrichment for ${Math.min(contactsNeedingEnrichment.length, REVEAL_LIMIT)} contacts...`);
          
          let enrichedCount = 0;
          for (let i = 0; i < Math.min(contactsNeedingEnrichment.length, REVEAL_LIMIT); i++) {
            const contact = contactsNeedingEnrichment[i];
            console.log(`   Enriching ${i + 1}/${Math.min(contactsNeedingEnrichment.length, REVEAL_LIMIT)}: ${contact.name}`);
            
            const enrichedData = await this.enrichApolloContact(contact, companyName, domain);
            
            if (enrichedData && enrichedData.email) {
              // Find and update the contact in the main array
              const index = contacts.findIndex(c => c.id === contact.id);
              if (index !== -1) {
                contacts[index] = { ...contacts[index], ...enrichedData, locked: false };
                enrichedCount++;
                console.log(`   ✅ Email found: ${enrichedData.email}`);
              }
            } else {
              console.log(`   ❌ No email found for ${contact.name}`);
            }
            
            // Small delay to avoid rate limiting
            if (i < contactsNeedingEnrichment.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          
          console.log(`\n📊 Enrichment complete: ${enrichedCount} emails revealed`);
        }

        // Final count
        const finalEmailCount = contacts.filter(c => c.email).length;
        console.log(`📧 Final result: ${finalEmailCount} contacts with emails out of ${contacts.length} total`);

        return {
          contacts,
          method: attemptDescription,
          totalFound: response.data.total_people || response.data.people.length,
          emailsFound: finalEmailCount
        };
      }

      console.log(`   No results for ${attemptDescription}`);
      return null;
    } catch (error) {
      console.error(`   Error in ${attemptDescription}:`, error.response?.data || error.message);
      return null;
    }
  };

  // Search strategies
  const searchStrategies = [];

  // Try organization search first
  if (companyName) {
    try {
      console.log(`\n🏢 Searching for organization: ${companyName}`);
      
      const orgResponse = await axios.post(
        'https://api.apollo.io/v1/organizations/search',
        {
          q_organization_name: cleanCompanyName(companyName),
          per_page: 3,
          page: 1
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': API_KEYS.APOLLO
          },
          timeout: 15000
        }
      );

      if (orgResponse.data?.organizations?.length > 0) {
        const org = orgResponse.data.organizations[0];
        console.log(`✅ Found org: ${org.name} (${org.primary_domain || org.website_url})`);
        
        const orgDomain = org.primary_domain || 
                         org.website_url?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') ||
                         domain;
        
        if (orgDomain) {
          searchStrategies.push({
            q_organization_domains: orgDomain,
            person_seniorities: ["owner", "founder", "c_suite", "partner", "vp", "director", "manager"],
            person_titles: ["regulatory", "compliance", "quality", "affairs", "director", "manager", "head"]
          });
        }
      }
    } catch (error) {
      console.error('Org search error:', error.response?.data || error.message);
    }
  }

  // Add domain search if provided
  if (domain && !searchStrategies.length) {
    searchStrategies.push({
      q_organization_domains: domain,
      person_seniorities: ["owner", "founder", "c_suite", "partner", "vp", "director", "manager"]
    });
  }

  // Add company name search
  if (companyName && !searchStrategies.length) {
    searchStrategies.push({
      q_organization_name: cleanCompanyName(companyName)
    });
  }

  // Execute search strategies
  for (let i = 0; i < searchStrategies.length; i++) {
    const strategy = searchStrategies[i];
    const result = await executeApolloSearch(strategy, `Strategy ${i + 1}`);
    
    if (result && result.contacts.length > 0) {
      finalResult = result;
      searchAttempts.push({ 
        type: `strategy_${i + 1}`, 
        success: true,
        contactsFound: result.contacts.length,
        emailsFound: result.emailsFound
      });
      break;
    }
  }

  if (finalResult) {
    console.log(`\n✅ Apollo search successful`);
    return finalResult;
  }

  console.log(`\n❌ No results found`);
  return {
    contacts: [],
    searchMetadata: {
      attempts: searchAttempts,
      error: 'No contacts found'
    }
  };
}

// Enhanced enrichment function that tries multiple methods
async enrichApolloContact(contact, companyName, domain) {
  if (!contact.id) return null;

  // Method 1: Direct people endpoint (often works without credits)
  try {
    const response = await axios.get(
      `https://api.apollo.io/v1/people/${contact.id}`,
      {
        headers: {
          'X-Api-Key': API_KEYS.APOLLO,
          'Cache-Control': 'no-cache'
        },
        timeout: 10000
      }
    );

    if (response.data?.person?.email) {
      return {
        email: response.data.person.email,
        phone: response.data.person.phone_number,
        email_status: response.data.person.email_status,
        verified: response.data.person.email_status === 'verified'
      };
    }
  } catch (e) {
    // Continue to next method
  }

  // Method 2: People match endpoint (consumes credits)
  try {
    const [firstName, ...lastNameParts] = (contact.name || '').split(' ');
    const lastName = lastNameParts.join(' ');
    
    const response = await axios.post(
      'https://api.apollo.io/v1/people/match',
      {
        first_name: firstName,
        last_name: lastName || firstName, // Fallback if no last name
        organization_name: companyName || contact.company,
        domain: domain || contact.domain,
        reveal_personal_emails: true,
        reveal_phone_number: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEYS.APOLLO,
          'Cache-Control': 'no-cache'
        },
        timeout: 10000
      }
    );

    if (response.data?.person?.email || response.data?.email) {
      return {
        email: response.data.person?.email || response.data.email,
        phone: response.data.person?.phone_number || response.data.phone_number,
        email_status: response.data.person?.email_status || response.data.email_status,
        verified: true
      };
    }
  } catch (error) {
    if (error.response?.status === 402) {
      console.log(`      💳 Out of credits for email reveal`);
    } else if (error.response?.status === 422) {
      console.log(`      ⚠️ No match found for ${contact.name}`);
    }
  }

  // Method 3: Email pattern generation (fallback)
  if (contact.name && (domain || contact.domain)) {
    const [firstName, ...lastNameParts] = contact.name.toLowerCase().split(' ');
    const lastName = lastNameParts.join('');
    const emailDomain = domain || contact.domain;
    
    // Common email patterns
    const patterns = [
      `${firstName}.${lastName}@${emailDomain}`,
      `${firstName}${lastName}@${emailDomain}`,
      `${firstName.charAt(0)}${lastName}@${emailDomain}`,
      `${firstName}@${emailDomain}`,
      `${firstName}_${lastName}@${emailDomain}`
    ];
    
    // Return the most likely pattern
    return {
      email: patterns[0],
      email_status: 'guessed',
      verified: false,
      pattern_generated: true
    };
  }

  return null;
}

// Add this validation function to check your setup
async validateApolloSetup() {
  try {
    // Check API key validity
    const response = await axios.get(
      'https://api.apollo.io/v1/auth/billing',
      {
        headers: {
          'X-Api-Key': API_KEYS.APOLLO,
          'Cache-Control': 'no-cache'
        }
      }
    );
    
    console.log('\n🔍 Apollo Account Status:');
    console.log('   ✅ API Key is valid');
    
    if (response.data) {
      console.log('   Plan:', response.data.plan_name || 'Unknown');
      console.log('   Credits used:', response.data.credits_used || 0);
      console.log('   Credits limit:', response.data.credits_limit || 'Unknown');
      console.log('   Email credits:', response.data.email_credits || 'Unknown');
    }
    
    return true;
  } catch (error) {
    console.error('\n❌ Apollo API Error:', error.response?.status, error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.error('   Invalid API key');
    } else if (error.response?.status === 402) {
      console.error('   Payment required - check your Apollo subscription');
    }
    
    return false;
  }
}

// Helper function to validate Apollo API key and check credits
// async validateApolloSetup() {
//   try {
//     const response = await axios.get(
//       'https://api.apollo.io/v1/auth/health',
//       {
//         headers: {
//           'X-Api-Key': API_KEYS.APOLLO
//         }
//       }
//     );
    
//     console.log('✅ Apollo API Key Valid');
//     console.log('   Credits remaining:', response.data?.credits_remaining || 'Unknown');
//     console.log('   Rate limit:', response.data?.rate_limit || 'Unknown');
    
//     return true;
//   } catch (error) {
//     console.error('❌ Apollo API validation failed:', error.response?.data || error.message);
//     return false;
//   }
// }

// async searchApollo(companyName, domain) {
//   const searchAttempts = [];
//   let finalResult = null;

//   // Helper function to clean company names
//   const cleanCompanyName = (name) => {
//     if (!name || typeof name !== 'string') return '';
    
//     return name
//       // Remove common company suffixes
//       .replace(/,?\s*(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|group|holdings|international|global|usa|america|us|technologies|tech|solutions|services|systems|software|digital|media|partners|ventures|capital|labs|studio|works|industries|enterprises)\.?$/gi, '')
//       // Remove special characters but keep spaces
//       .replace(/[^\w\s&-]/g, '')
//       // Remove numbers at the end (like "Company 2024")
//       .replace(/\s+\d{2,4}$/g, '')
//       // Remove parenthetical additions
//       .replace(/\s*\([^)]*\)/g, '')
//       // Clean up whitespace
//       .replace(/\s+/g, ' ')
//       .trim();
//   };

//   // Helper to extract potential domain from company name
//   const generatePotentialDomains = (name) => {
//     const cleaned = cleanCompanyName(name)
//       .toLowerCase()
//       .replace(/[^a-z0-9]/g, '');
    
//     const domains = [
//       `${cleaned}.com`,
//       `${cleaned}.io`,
//       `${cleaned}.co`,
//       `${cleaned}.net`,
//       `${cleaned}.org`,
//       `${cleaned}.ai`,
//       `${cleaned}.app`,
//       `${cleaned}.dev`
//     ];

//     // Try without common words if name has multiple words
//     const words = cleanCompanyName(name).toLowerCase().split(' ');
//     if (words.length > 1) {
//       const abbreviated = words.map(w => w[0]).join('');
//       domains.push(`${abbreviated}.com`, `${abbreviated}.io`);
      
//       // Try first word only
//       domains.push(`${words[0]}.com`);
      
//       // Try combination of main words
//       const mainWords = words.filter(w => w.length > 3).join('');
//       if (mainWords) {
//         domains.push(`${mainWords}.com`);
//       }
//     }

//     return [...new Set(domains)]; // Remove duplicates
//   };

//   // Helper to search Apollo with specific parameters
//   const executeApolloSearch = async (searchParams, attemptDescription) => {
//     try {
//       console.log(`🔍 Apollo attempt: ${attemptDescription}`);
//       console.log('   Parameters:', JSON.stringify(searchParams, null, 2));

//       const response = await axios.post(
//         'https://api.apollo.io/v1/mixed_people/search',
//         {
//           per_page: 10,
//           page: 1,
//           ...searchParams
//         },
//         {
//           headers: {
//             'Content-Type': 'application/json',
//             'X-Api-Key': API_KEYS.APOLLO
//           },
//           timeout: 15000
//         }
//       );

//       if (response.data?.people?.length > 0) {
//         console.log(`✅ Found ${response.data.people.length} contacts via ${attemptDescription}`);
//         return {
//           contacts: response.data.people.map(p => ({
//             name: p.name,
//             title: p.title,
//             email: p.email,
//             linkedin: p.linkedin_url,
//             verified: p.email_status === 'verified',
//             company: p.organization?.name,
//             domain: p.organization?.domain
//           })),
//           method: attemptDescription,
//           totalFound: response.data.total_people || response.data.people.length
//         };
//       }
      
//       console.log(`   No results for ${attemptDescription}`);
//       return null;
//     } catch (error) {
//       console.error(`   Error in ${attemptDescription}:`, error.response?.data?.error || error.message);
//       return null;
//     }
//   };

//   // ATTEMPT 1: Search by provided domain if valid
//   if (domain && typeof domain === 'string' && domain.includes('.')) {
//     const result = await executeApolloSearch(
//       { q_organization_domains: domain },
//       `domain search: ${domain}`
//     );
//     if (result) {
//       finalResult = result;
//       searchAttempts.push({ type: 'domain', value: domain, success: true });
//     } else {
//       searchAttempts.push({ type: 'domain', value: domain, success: false });
//     }
//   }

//   // ATTEMPT 2: Search by exact company name
//   if (!finalResult && companyName) {
//     const result = await executeApolloSearch(
//       { q_organization_name: companyName },
//       `exact name: "${companyName}"`
//     );
//     if (result) {
//       finalResult = result;
//       searchAttempts.push({ type: 'exact_name', value: companyName, success: true });
//     } else {
//       searchAttempts.push({ type: 'exact_name', value: companyName, success: false });
//     }
//   }

//   // ATTEMPT 3: Search with cleaned company name
//   if (!finalResult && companyName) {
//     const cleanedName = cleanCompanyName(companyName);
//     if (cleanedName && cleanedName !== companyName) {
//       const result = await executeApolloSearch(
//         { q_organization_name: cleanedName },
//         `cleaned name: "${cleanedName}"`
//       );
//       if (result) {
//         finalResult = result;
//         searchAttempts.push({ type: 'cleaned_name', value: cleanedName, success: true });
//       } else {
//         searchAttempts.push({ type: 'cleaned_name', value: cleanedName, success: false });
//       }
//     }
//   }

//   // ATTEMPT 4: Try with fuzzy/partial matching
//   if (!finalResult && companyName) {
//     const partialName = cleanCompanyName(companyName).split(' ')[0];
//     if (partialName && partialName.length > 3) {
//       const result = await executeApolloSearch(
//         { 
//           q_organization_name: partialName,
//           organization_name_fuzzy: true  // If Apollo supports fuzzy matching
//         },
//         `partial name: "${partialName}"`
//       );
//       if (result) {
//         finalResult = result;
//         searchAttempts.push({ type: 'partial_name', value: partialName, success: true });
//       } else {
//         searchAttempts.push({ type: 'partial_name', value: partialName, success: false });
//       }
//     }
//   }

//   // ATTEMPT 5: Try generated domains
//   if (!finalResult && companyName) {
//     const potentialDomains = generatePotentialDomains(companyName);
//     console.log(`🔄 Trying ${potentialDomains.length} potential domains...`);
    
//     for (const testDomain of potentialDomains.slice(0, 5)) { // Limit to 5 attempts
//       const result = await executeApolloSearch(
//         { q_organization_domains: testDomain },
//         `generated domain: ${testDomain}`
//       );
//       if (result) {
//         finalResult = result;
//         searchAttempts.push({ type: 'generated_domain', value: testDomain, success: true });
//         break;
//       } else {
//         searchAttempts.push({ type: 'generated_domain', value: testDomain, success: false });
//       }
//     }
//   }

//   // ATTEMPT 6: Search using organization search endpoint first
//   if (!finalResult && companyName) {
//     try {
//       console.log(`🔍 Attempting organization lookup for: ${companyName}`);
      
//       const orgResponse = await axios.post(
//         'https://api.apollo.io/v1/organizations/search',
//         {
//           q_organization_name: cleanCompanyName(companyName),
//           per_page: 3,
//           page: 1
//         },
//         {
//           headers: {
//             'Content-Type': 'application/json',
//             'X-Api-Key': API_KEYS.APOLLO
//           },
//           timeout: 15000
//         }
//       );

//       if (orgResponse.data?.organizations?.length > 0) {
//         // Try each organization found
//         for (const org of orgResponse.data.organizations) {
//           const orgDomain = org.primary_domain || org.domains?.[0];
//           if (orgDomain) {
//             console.log(`✅ Found organization: ${org.name} with domain: ${orgDomain}`);
            
//             const result = await executeApolloSearch(
//               { q_organization_domains: orgDomain },
//               `org lookup domain: ${orgDomain} (${org.name})`
//             );
            
//             if (result) {
//               finalResult = {
//                 ...result,
//                 organization: {
//                   name: org.name,
//                   domain: orgDomain,
//                   industry: org.industry,
//                   size: org.estimated_num_employees
//                 }
//               };
//               searchAttempts.push({ type: 'org_lookup', value: org.name, success: true });
//               break;
//             }
//           }
//         }
//       }
//     } catch (error) {
//       console.error('Organization lookup error:', error.response?.data || error.message);
//       searchAttempts.push({ type: 'org_lookup', value: companyName, success: false });
//     }
//   }

//   // ATTEMPT 7: Try alternative name formats
//   if (!finalResult && companyName) {
//     const alternativeFormats = [
//       companyName.toUpperCase(),
//       companyName.toLowerCase(),
//       companyName.replace(/&/g, 'and'),
//       companyName.replace(/\band\b/gi, '&'),
//       companyName.replace(/\s+/g, ''),  // No spaces
//       companyName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') // Title case
//     ];

//     for (const altName of [...new Set(alternativeFormats)]) {
//       if (altName !== companyName && altName !== cleanCompanyName(companyName)) {
//         const result = await executeApolloSearch(
//           { q_organization_name: altName },
//           `alternative format: "${altName}"`
//         );
//         if (result) {
//           finalResult = result;
//           searchAttempts.push({ type: 'alternative_format', value: altName, success: true });
//           break;
//         }
//       }
//     }
//   }

//   // Log summary
//   console.log('\n📊 Apollo Search Summary:');
//   console.log(`   Total attempts: ${searchAttempts.length}`);
//   console.log(`   Successful: ${searchAttempts.filter(a => a.success).length}`);
//   console.log(`   Failed: ${searchAttempts.filter(a => !a.success).length}`);
  
//   if (finalResult) {
//     console.log(`   ✅ Final result: ${finalResult.totalFound} contacts found via ${finalResult.method}`);
//     console.log(`   Search attempts:`, searchAttempts);
    
//     // Add metadata about the search process
//     finalResult.searchMetadata = {
//       attempts: searchAttempts,
//       originalCompanyName: companyName,
//       originalDomain: domain,
//       successfulMethod: finalResult.method
//     };
//   } else {
//     console.log(`   ❌ No results found after all attempts`);
//     console.log(`   Search attempts:`, searchAttempts);
    
//     // Return empty result with metadata
//     return {
//       contacts: [],
//       searchMetadata: {
//         attempts: searchAttempts,
//         originalCompanyName: companyName,
//         originalDomain: domain,
//         successfulMethod: null,
//         error: 'No contacts found after exhaustive search'
//       }
//     };
//   }

//   return finalResult;
// }
// Helper: reveal Apollo email for a single person id via People Enrichment
async revealApolloEmail(personId) {
  if (!personId) return null;

  try {
    // Use the correct endpoint for revealing emails
    const resp = await axios.post(
      'https://api.apollo.io/api/v1/people/enrich',  // Changed endpoint
      {
        id: personId,  // Changed from person_id to id
        reveal_personal_emails: true,
        reveal_phone_number: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': API_KEYS.APOLLO
        },
        timeout: 15000
      }
    );

    const person = resp.data?.person || resp.data;
    if (!person) return null;

    // Apollo returns email in different places depending on the endpoint
    const primaryEmail = 
      person.email ||
      person.work_email ||
      person.personal_email ||
      (person.email_addresses && person.email_addresses[0]) ||
      null;

    return {
      email: primaryEmail,
      email_status: person.email_status || 'revealed'
    };
  } catch (error) {
    const code = error.response?.status;
    const msg = error.response?.data?.error || error.message;
    
    // Common error codes:
    // 402: Payment required (out of credits)
    // 403: Forbidden (API key doesn't have permission)
    // 404: Person not found
    // 422: Invalid request
    
    console.error(`   🔒 Reveal failed for person ${personId} [${code || 'ERR'}]: ${msg}`);
    
    if (code === 402) {
      console.error('   ⚠️ Out of Apollo credits for email reveals');
    }
    
    return null;
  }
}


// Optional: Standalone function to validate and find company domain
async  findAndValidateCompanyDomain(companyName) {
  try {
    // First try Apollo's organization search
    const orgResponse = await axios.post(
      'https://api.apollo.io/v1/organizations/search',
      {
        q_organization_name: companyName,
        per_page: 1,
        page: 1
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEYS.APOLLO
        },
        timeout: 15000
      }
    );

    if (orgResponse.data?.organizations?.[0]) {
      const org = orgResponse.data.organizations[0];
      return {
        domain: org.primary_domain || org.domains?.[0],
        companyName: org.name,
        confidence: 'high',
        source: 'apollo_org_search'
      };
    }
  } catch (error) {
    console.error('Domain lookup error:', error.message);
  }

  // Fallback to generating domain
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '');
  
  return {
    domain: `${cleaned}.com`,
    companyName: companyName,
    confidence: 'low',
    source: 'generated'
  };
}

  // async findContactsForCompany(companyName, domain = null) {
  //   console.log(`📧 Finding contacts for: ${companyName}`);
    
  //   const canonical = this.findCanonicalName(companyName);
    
  //   // Get or find domain
  //   if (!domain) {
  //     domain = await this.findCompanyDomain(canonical);
  //   }
    
  //   console.log(`🌐 Using domain: ${domain}`);
    
  //   const contactInfo = {
  //     company: canonical,
  //     domain: domain,
  //     emails: [],
  //     contacts: [],
  //     searched: true
  //   };
    
  //   try {
  //     // Try Hunter
  //     if (API_KEYS.HUNTER) {
  //       const hunterData = await this.searchHunter(domain, canonical);
  //       if (hunterData && hunterData.emails) {
  //         contactInfo.emails.push(...hunterData.emails);
  //       }
  //     }
      
  //     // Try Apollo
  //     if (API_KEYS.APOLLO) {
  //       const apolloData = await this.searchApollo(canonical, domain);
  //       if (apolloData && apolloData.contacts) {
  //         contactInfo.contacts.push(...apolloData.contacts);
  //         // Add Apollo emails to main list
  //         apolloData.contacts.forEach(c => {
  //           if (c.email) {
  //             contactInfo.emails.push({
  //               email: c.email,
  //               name: c.name,
  //               position: c.title,
  //               verified: c.verified
  //             });
  //           }
  //         });
  //       }
  //     }
      
  //     // If no APIs configured or no results, generate fallback emails
  //     if (contactInfo.emails.length === 0) {
  //       console.log('⚠️ No contacts found via APIs, generating fallbacks');
  //       contactInfo.emails = [
  //         { email: `info@${domain}`, name: 'General Info', position: 'General' },
  //         { email: `regulatory@${domain}`, name: 'Regulatory Affairs', position: 'Regulatory' },
  //         { email: `quality@${domain}`, name: 'Quality Assurance', position: 'Quality' },
  //         { email: `compliance@${domain}`, name: 'Compliance', position: 'Compliance' }
  //       ];
  //     }
      
  //   } catch (error) {
  //     console.error(`Error finding contacts for ${canonical}:`, error.message);
  //   }
    
  //   console.log(`📊 Found ${contactInfo.emails.length} total emails`);
  //   this.contacts.set(canonical, contactInfo);
  //   return contactInfo;
  // }
  async  findContactsForCompany(companyName, domain = null) {
  console.log(`📧 Finding contacts for: ${companyName}`);

  const canonical = this.findCanonicalName(companyName);

  // Get or find domain
  if (!domain) {
    domain = await this.findCompanyDomain(canonical);
  }

  console.log(`🌐 Using domain: ${domain}`);

  const contactInfo = {
    company: canonical,
    domain: domain,
    emails: [],
    contacts: [],
    searched: true
  };

  try {
    // Hunter
    if (API_KEYS.HUNTER) {
      const hunterData = await this.searchHunter(domain, canonical);
      if (hunterData && hunterData.emails) {
        contactInfo.emails.push(...hunterData.emails);
      }
    }

    // Apollo
    if (API_KEYS.APOLLO) {
      const apolloData = await this.searchApollo(canonical, domain);
      if (apolloData && apolloData.contacts) {
        contactInfo.contacts.push(...apolloData.contacts);

        // Add Apollo emails to main list (now includes revealed ones)
        apolloData.contacts.forEach(c => {
          if (c.email) {
            contactInfo.emails.push({
              email: c.email,
              name: c.name,
              position: c.title,
              verified: !!c.verified
            });
          } else {
            // Still locked/unavailable — surface to UI as non-sending entry
            contactInfo.emails.push({
              email: null,
              name: c.name,
              position: c.title,
              verified: false,
              locked: true,
              status_reason: c.email_status || 'not_unlocked'
            });
          }
        });
      }
    }

    // If truly nothing usable, generate fallbacks
    const hasReal = contactInfo.emails.some(e => e.email);
    if (!hasReal) {
      console.log('⚠️ No deliverable emails found via APIs, generating fallbacks');
      contactInfo.emails = [
        { email: `info@${domain}`, name: 'General Info', position: 'General' },
        { email: `regulatory@${domain}`, name: 'Regulatory Affairs', position: 'Regulatory' },
        { email: `quality@${domain}`, name: 'Quality Assurance', position: 'Quality' },
        { email: `compliance@${domain}`, name: 'Compliance', position: 'Compliance' }
      ];
    }
  } catch (error) {
    console.error(`Error finding contacts for ${canonical}:`, error.message);
  }

  console.log(`📊 Found ${contactInfo.emails.length} total emails (incl. locked/placeholders)`);
  this.contacts.set(canonical, contactInfo);
  return contactInfo;
}


  updateMetrics() {
    this.metrics = {
      totalCompanies: this.companies.size,
      totalViolations: Array.from(this.companies.values())
        .reduce((sum, c) => sum + (c.violations?.length || 0), 0),
      topViolators: this.getTopViolators(10)
    };
  }

  getTopViolators(limit = 10) {
    return Array.from(this.companies.values())
      .sort((a, b) => (b.violations?.length || 0) - (a.violations?.length || 0))
      .slice(0, limit)
      .map(c => ({
        name: c.name,
        violations: c.violations?.length || 0,
        risk_score: c.risk_score || 0,
        compliance_score: c.compliance_score || 100
      }));
  }

  async save() {
    try {
      const companiesArray = Array.from(this.companies.values());
      await fs.writeFile(DATA_FILES.COMPANIES, JSON.stringify(companiesArray, null, 2));
      
      const cacheObj = {};
      this.aiCache.forEach((value, key) => {
        cacheObj[key] = value;
      });
      await fs.writeFile(DATA_FILES.AI_CACHE, JSON.stringify(cacheObj, null, 2));
      
      await fs.writeFile(DATA_FILES.METRICS, JSON.stringify(this.metrics, null, 2));
      
      console.log('✅ Company data saved');
    } catch (error) {
      console.error('Error saving company data:', error);
    }
  }

  async saveContacts() {
    try {
      const contactsArray = Array.from(this.contacts.values());
      await fs.writeFile(DATA_FILES.CONTACTS, JSON.stringify(contactsArray, null, 2));
    } catch (error) {
      console.error('Error saving contacts:', error);
    }
  }
  notificationQueue = [];


}
class WarningLetterScraper {
  constructor() {
    this.cache = new Map();
    this.rateLimiter = {
      lastRequest: 0,
      minDelay: 1000, // 1 second between requests
      maxRetries: 3
    };
  }

  // Main scraping method
  async scrapeWarningLetter(url) {
    // Check cache first
    if (this.cache.has(url)) {
      console.log(`📋 Using cached data for: ${url}`);
      return this.cache.get(url);
    }

    // Rate limiting
    await this.enforceRateLimit();

    let lastError = null;
    for (let attempt = 1; attempt <= this.rateLimiter.maxRetries; attempt++) {
      try {
        console.log(`🔍 Scraping warning letter (attempt ${attempt}): ${url}`);
        
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          },
          timeout: 15000,
          maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const letterData = this.extractLetterData($, url);
        
        // Cache the result
        this.cache.set(url, letterData);
        
        // Clean old cache entries if too large
        if (this.cache.size > 100) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        
        console.log(`✅ Successfully scraped warning letter`);
        return letterData;
        
      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.rateLimiter.maxRetries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
      }
    }
    
    // If all retries failed, return partial data
    console.error(`⚠️ All scraping attempts failed for ${url}`);
    return {
      success: false,
      error: lastError?.message || 'Failed to scrape warning letter',
      url: url,
      scrapedAt: new Date().toISOString()
    };
  }

  // Extract data from the HTML
  extractLetterData($, url) {
    const data = {
      success: true,
      url: url,
      scrapedAt: new Date().toISOString(),
      
      // Basic Info
      title: this.extractTitle($),
      marcsNumber: this.extractMarcsNumber($),
      letterDate: this.extractLetterDate($),
      issueDate: this.extractIssueDate($),
      
      // Delivery Info
      deliveryMethod: this.extractDeliveryMethod($),
      productType: this.extractProductType($),
      
      // Recipient Info
      recipient: this.extractRecipient($),
      
      // Issuing Office
      issuingOffice: this.extractIssuingOffice($),
      
      // Letter Content
      letterContent: this.extractLetterContent($),
      violations: this.extractViolations($),
      products: this.extractProducts($),
      
      // Response Requirements
      responseDeadline: this.extractResponseDeadline($),
      responseEmail: this.extractResponseEmail($),
      
      // Metadata
      contentDate: this.extractContentDate($),
      regulatedProducts: this.extractRegulatedProducts($)
    };
    
    // Extract company name from recipient if available
    if (data.recipient && data.recipient.company) {
      data.companyName = data.recipient.company;
    }
    
    return data;
  }

  // Individual extraction methods
  extractTitle($) {
    // Try multiple selectors
    let title = $('h1.content-title').first().text().trim();
    if (!title) {
      title = $('h1').first().text().trim();
    }
    if (!title) {
      title = $('meta[property="og:title"]').attr('content') || '';
    }
    return title.replace(/\s+/g, ' ').trim();
  }

  extractMarcsNumber($) {
    const title = this.extractTitle($);
    const match = title.match(/MARCS-CMS\s+(\d+)/i) || title.match(/(\d{6})/);
    if (match) return match[1];
    
    // Try to find in the letter content
    const content = $('body').text();
    const contentMatch = content.match(/MARCS-CMS\s+(\d+)/i) || content.match(/RE:\s*(\d{6})/i);
    return contentMatch ? contentMatch[1] : null;
  }

  extractLetterDate($) {
    // Look for date in title first
    const title = this.extractTitle($);
    const titleMatch = title.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (titleMatch) return titleMatch[1];
    
    // Look for time element
    const timeElement = $('time').first();
    if (timeElement.length) {
      return timeElement.attr('datetime') || timeElement.text().trim();
    }
    
    // Look in the letter content for date pattern
    const letterContent = $('.inset-column').text() || $('main').text();
    const dateMatch = letterContent.match(/([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
    return dateMatch ? dateMatch[1] : null;
  }

  extractIssueDate($) {
    const published = $('meta[property="article:published_time"]').attr('content');
    if (published) return published;
    
    const modified = $('meta[property="article:modified_time"]').attr('content');
    return modified || null;
  }

  extractDeliveryMethod($) {
    const deliveryDt = $('dt:contains("Delivery Method")');
    if (deliveryDt.length) {
      return deliveryDt.next('dd').text().trim();
    }
    return 'Not specified';
  }

  extractProductType($) {
    const productDt = $('dt:contains("Product")');
    if (productDt.length) {
      return productDt.next('dd').text().trim();
    }
    return 'Not specified';
  }

  extractRecipient($) {
    const recipient = {};
    
    // Look for recipient section
    const recipientDt = $('dt:contains("Recipient")');
    if (recipientDt.length) {
      const recipientSection = recipientDt.nextUntil('dt');
      
      // Extract name
      const nameField = recipientSection.find('.field--name-field-recipient-name .field--item');
      if (nameField.length) {
        recipient.name = nameField.text().trim();
      }
      
      // Extract title
      const titleField = recipientSection.find('.field--name-field-recipient-title .field--item');
      if (titleField.length) {
        recipient.title = titleField.text().trim();
      }
      
      // Extract company (usually in a dd after name/title)
      recipientSection.each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && !text.includes('Recipient') && !text.includes(recipient.name) && !text.includes(recipient.title)) {
          if (!recipient.company && text.length > 2 && !text.includes('@')) {
            recipient.company = text;
          }
        }
      });
      
      // Extract address
      const address = recipientSection.find('.address');
      if (address.length) {
        recipient.address = {
          street: address.find('.address-line1').text().trim(),
          city: address.find('.locality').text().trim(),
          state: address.find('.administrative-area').text().trim(),
          zip: address.find('.postal-code').text().trim(),
          country: address.find('.country').text().trim()
        };
        recipient.fullAddress = `${recipient.address.street}, ${recipient.address.city}, ${recipient.address.state} ${recipient.address.zip}`;
      }
      
      // Extract email
      const emailLink = recipientSection.find('a[href^="mailto:"]');
      if (emailLink.length) {
        recipient.email = emailLink.attr('href').replace('mailto:', '');
      }
    }
    
    // Fallback: try to extract from meta tags
    if (!recipient.company) {
      const ogTitle = $('meta[property="og:title"]').attr('content');
      if (ogTitle) {
        const match = ogTitle.match(/^([^-]+)\s*-/);
        if (match) {
          recipient.company = match[1].trim();
        }
      }
    }
    
    return recipient;
  }

  extractIssuingOffice($) {
    const issuingDt = $('dt:contains("Issuing Office")');
    if (issuingDt.length) {
      const office = issuingDt.next('dd').text().trim();
      return office;
    }
    
    // Look for CDER or other FDA offices in content
    const content = $('body').text();
    if (content.includes('Center for Drug Evaluation and Research')) {
      return 'Center for Drug Evaluation and Research (CDER)';
    }
    if (content.includes('Center for Devices and Radiological Health')) {
      return 'Center for Devices and Radiological Health (CDRH)';
    }
    if (content.includes('Center for Biologics Evaluation and Research')) {
      return 'Center for Biologics Evaluation and Research (CBER)';
    }
    
    return 'FDA';
  }

  extractLetterContent($) {
    // Main content is usually after the hr tags
    const mainContent = $('hr').last().nextAll();
    let content = '';
    
    mainContent.each((i, elem) => {
      const text = $(elem).text().trim();
      if (text) {
        content += text + '\n\n';
      }
    });
    
    // If that didn't work, try other selectors
    if (!content) {
      content = $('.inset-column').nextAll().text().trim();
    }
    
    if (!content) {
      content = $('main p').text().trim();
    }
    
    return content.substring(0, 5000); // Limit to 5000 chars for storage
  }

  extractViolations($) {
    const violations = [];
    
    // Look for bulleted lists after "Examples of claims" or similar phrases
    const lists = $('ul li, ol li');
    lists.each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && (text.includes('claim') || text.includes('violation') || text.includes('antimicrobial') || text.includes('treat'))) {
        violations.push(text);
      }
    });
    
    // Also look for specific violation patterns in the content
    const content = this.extractLetterContent($);
    const violationPatterns = [
      /unapproved new drug/gi,
      /misbranded/gi,
      /adulterated/gi,
      /not generally recognized as safe/gi,
      /GRASE/g,
      /section \d+\([a-z]\)/gi
    ];
    
    violationPatterns.forEach(pattern => {
      const matches = content.match(pattern);
      if (matches) {
        violations.push(...matches);
      }
    });
    
    // Deduplicate
    return [...new Set(violations)].slice(0, 10); // Limit to 10 violations
  }

  extractProducts($) {
    const products = [];
    
    // Look for product names in quotes
    const content = this.extractLetterContent($);
    const quotedProducts = content.match(/"([^"]+)"/g);
    if (quotedProducts) {
      quotedProducts.forEach(product => {
        const cleaned = product.replace(/"/g, '').trim();
        if (cleaned.length > 3 && cleaned.length < 100) {
          products.push(cleaned);
        }
      });
    }
    
    // Look for specific product mentions
    const productPatterns = [
      /product[s]?\s+(?:called|named|labeled|marketed as)\s+"?([^".\n]+)"?/gi,
      /your\s+"([^"]+)"\s+product/gi
    ];
    
    productPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) {
          products.push(match[1].trim());
        }
      }
    });
    
    // Deduplicate
    return [...new Set(products)].slice(0, 5); // Limit to 5 products
  }

  extractResponseDeadline($) {
    const content = this.extractLetterContent($);
    
    // Look for common deadline phrases
    const patterns = [
      /within\s+(\d+)\s+(?:working\s+)?days/i,
      /(\d+)\s+(?:working\s+)?days\s+of\s+receipt/i,
      /respond\s+(?:by|within)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1] + (match[1].match(/\d+/) ? ' days' : '');
      }
    }
    
    return 'Not specified';
  }

  extractResponseEmail($) {
    const content = this.extractLetterContent($);
    
    // Look for FDA advisory email
    const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = content.match(emailPattern);
    
    if (emails) {
      // Prefer FDA emails
      const fdaEmail = emails.find(email => email.includes('fda.hhs.gov') || email.includes('fda.gov'));
      if (fdaEmail) return fdaEmail;
      
      // Return first email that's not the recipient's
      const recipientEmail = this.extractRecipient($).email;
      return emails.find(email => email !== recipientEmail) || emails[0];
    }
    
    return null;
  }

  extractContentDate($) {
    const contentDate = $('.node-current-date time').attr('datetime');
    if (contentDate) return contentDate;
    
    const contentText = $('.node-current-date').text();
    const match = contentText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    return match ? match[1] : null;
  }

  extractRegulatedProducts($) {
    const products = [];
    
    // Look in the metadata section
    $('.lcds-metadata-list li').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text) {
        products.push(text);
      }
    });
    
    // Also check the Product field
    const productType = this.extractProductType($);
    if (productType && productType !== 'Not specified' && !products.includes(productType)) {
      products.push(productType);
    }
    
    return products;
  }

  // Rate limiting
  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.rateLimiter.lastRequest;
    
    if (timeSinceLastRequest < this.rateLimiter.minDelay) {
      const delay = this.rateLimiter.minDelay - timeSinceLastRequest;
      console.log(`⏳ Rate limiting: waiting ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.rateLimiter.lastRequest = Date.now();
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    console.log('🗑️ Warning letter cache cleared');
  }
}

// Create singleton instance
const warningLetterScraper = new WarningLetterScraper();

// Add this endpoint to your Express app
app.get('/api/warning-letter/scrape', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required'
      });
    }
    
    // Validate it's an FDA URL
    if (!url.includes('fda.gov')) {
      return res.status(400).json({
        success: false,
        error: 'Only FDA.gov URLs are allowed'
      });
    }
    
    // Scrape the warning letter
    const letterData = await warningLetterScraper.scrapeWarningLetter(url);
    
    res.json({
      success: letterData.success !== false,
      data: letterData
    });
    
  } catch (error) {
    console.error('Warning letter scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// COMPLETE REPLACEMENT FOR /api/ai/enhance endpoint
// app.post('/api/ai/enhance', async (req, res) => {
//   try {
//     const { itemId, title, link, summary, source, types, date } = req.body;
    
//     console.log('\n🤖 AI Enhancement Request:');
//     console.log('Title:', title?.substring(0, 100));
//     console.log('Has OpenAI:', !!openai);
    
//     // Build comprehensive content for analysis
//     const fullContent = `
// Title: ${title || 'No title'}
// Date: ${date || 'Unknown date'}
// Source: ${source || 'Unknown source'}
// Types: ${types?.join(', ') || 'Unknown type'}
// Link: ${link || 'No link'}
// Summary: ${summary || 'No summary available'}
//     `.trim();
    
//     let aiResult = {
//       canonical_company_name: 'Unknown Company',
//       summary: summary || 'No summary available',
//       emails: [],
//       contacts: []
//     };
    
//     // Try AI extraction if available
//     if (openai) {
//       try {
//         console.log('🔮 Calling OpenAI...');
        
//         const completion = await openai.chat.completions.create({
//           model: "gpt-4-turbo-preview",
//           messages: [
//             {
//               role: "system",
//               content: `You are an FDA regulatory expert. Extract and analyze information from FDA regulatory documents.
              
// IMPORTANT: Look for company names in these patterns:
// - "Warning Letter to [COMPANY NAME]"
// - "[COMPANY NAME] - Warning Letter"
// - "Issued to [COMPANY NAME]"
// - Company names often appear near the beginning of titles
// - Look for Inc., Corp., LLC, Ltd., Pharmaceuticals, Pharma, Biotech, etc.

// Return a JSON object with these fields:
// - canonical_company_name: The actual company name (be very careful to extract the real company, not FDA or generic terms)
// - summary: A detailed 3-4 sentence summary of the regulatory action
// - regulatory_impact: Specific regulatory implications
// - business_impact: Business and market implications
// - action_required: What the company needs to do
// - timeline: Response timeline if mentioned
// - severity_assessment: Your assessment of severity (1-10 scale)
// - key_violations: Array of specific violations mentioned`
//             },
//             {
//               role: "user",
//               content: `Extract the company name and analyze this FDA regulatory action:\n\n${fullContent}\n\nReturn ONLY valid JSON.`
//             }
//           ],
//           temperature: 0.2,
//           max_tokens: 1500,
//           response_format: { type: "json_object" }
//         });
        
//         const aiResponse = completion.choices[0].message.content;
//         console.log('✅ OpenAI responded');
        
//         try {
//           aiResult = { ...aiResult, ...JSON.parse(aiResponse) };
//           console.log('📊 Extracted company:', aiResult.canonical_company_name);
//         } catch (parseError) {
//           console.error('Failed to parse AI response:', parseError);
//           aiResult.summary = aiResponse;
//         }
        
//       } catch (aiError) {
//         console.error('OpenAI error:', aiError.message);
//       }
//     } else {
//       console.log('⚠️ OpenAI not configured, using fallback');
      
//       // Try basic extraction from title
//       const patterns = [
//         /Warning Letter to\s+([A-Z][A-Za-z0-9\s&,\.']+?)(?:\s*[-–:]|\s+regarding)/i,
//         /([A-Z][A-Za-z0-9\s&,\.']+?)\s*[-–:]\s*Warning Letter/i,
//         /([A-Z][A-Za-z0-9\s&,\.']+?)\s+(?:Receives?|Gets?)\s+(?:Complete Response Letter|CRL)/i,
//         /Form 483.*?(?:for|to|issued to)\s+([A-Z][A-Za-z0-9\s&,\.']+?)(?:\s*[-–,]|$)/i
//       ];
      
//       for (const pattern of patterns) {
//         const match = title?.match(pattern);
//         if (match && match[1]) {
//           aiResult.canonical_company_name = match[1].trim();
//           console.log('📊 Pattern matched company:', aiResult.canonical_company_name);
//           break;
//         }
//       }
//     }
    
//     // Now search for contacts if we have a company name
//     let contactsData = null;
//     if (aiResult.canonical_company_name && aiResult.canonical_company_name !== 'Unknown Company') {
//       console.log(`\n📧 Searching contacts for: ${aiResult.canonical_company_name}`);
      
//       // Find domain for the company
//       const domain = await companyIntel.findCompanyDomain(aiResult.canonical_company_name);
//       console.log(`🌐 Domain: ${domain}`);
      
//       // Search for contacts
//       contactsData = await companyIntel.findContactsForCompany(aiResult.canonical_company_name, domain);
      
//       if (contactsData) {
//         aiResult.emails = contactsData.emails?.map(e => e.email || e) || [];
//         aiResult.contacts = contactsData;
//         console.log(`✅ Found ${aiResult.emails.length} emails`);
//       }
//     }
    
//     // Cache the result
//     if (aiResult.canonical_company_name !== 'Unknown Company') {
//       companyIntel.aiCache.set(title, aiResult);
//     }
    
//     console.log('\n✅ Enhancement complete\n');
    
//     res.json({
//       success: true,
//       ...aiResult,
//       debug: {
//         hadOpenAI: !!openai,
//         hadHunter: !!API_KEYS.HUNTER,
//         hadApollo: !!API_KEYS.APOLLO,
//         foundCompany: aiResult.canonical_company_name !== 'Unknown Company',
//         emailCount: aiResult.emails.length
//       }
//     });
    
//   } catch (error) {
//     console.error('AI enhance error:', error);
//     res.status(500).json({ 
//       success: false, 
//       error: error.message,
//       canonical_company_name: 'Unknown Company',
//       summary: 'Enhancement failed',
//       emails: []
//     });
//   }
// });

// Initialize company intelligence
const companyIntel = new CompanyIntelligenceSystem();

// Classification and extraction functions
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

// Fetch RSS feeds with retry logic
async function fetchFeed(source, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📡 Fetching: ${source.name} (attempt ${attempt})`);
      
      const feed = await parser.parseURL(source.url);
      const results = [];
      
      feed.items.forEach(item => {
        const date = new Date(item.pubDate || item.isoDate || Date.now());
        const classification = classifyItem(item.title, item.contentSnippet || item.content || '');
        const company = companyIntel.extractCompanyName(
          item.title,
          item.content || item.contentSnippet || '',
          item.link,
          source.name
        );
        
        results.push({
          id: crypto.randomBytes(16).toString('hex'),
          title: item.title || 'No title',
          link: item.link || item.guid || '',
          date: date.toISOString(),
          dateFormatted: date.toLocaleDateString(),
          source: source.name,
          sourceCategory: source.category,
          sourceType: source.type,
          summary: item.contentSnippet || item.content || '',
          company: company,
          types: classification.types,
          severity: classification.severity,
          priority: source.priority || 5
        });
      });
      
      console.log(`✅ ${source.name}: ${results.length} items`);
      return results;
      
    } catch (error) {
      console.error(`❌ ${source.name} attempt ${attempt} failed:`, error.message);
      if (attempt === retries) {
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  
  return [];
}

// Enhanced FDA scraping with multiple strategies
async function scrapeFDAWarningLetters() {
  const results = [];
  
  try {
    console.log('🔍 Scraping FDA Warning Letters page...');
    
    const response = await axios.get(
      'https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters',
      {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      }
    );
    
    const $ = cheerio.load(response.data);
    
    // Try multiple selectors
    const selectors = [
      'table tbody tr',
      '.views-table tbody tr',
      '.warning-letter-list tr',
      'article.node--type-warning-letter',
      '.view-warning-letters tbody tr',
      '.view-content tbody tr'
    ];
    
    for (const selector of selectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        console.log(`Found ${elements.length} elements with selector: ${selector}`);
        
        elements.each((i, elem) => {
          const $row = $(elem);
          const link = $row.find('a').first();
          const href = link.attr('href');
          const title = link.text() || $row.find('td').first().text();
          const dateText = $row.find('td').last().text() || 
                          $row.find('.date').text() || 
                          $row.find('time').text();
          
          if (href && title && title.length > 10) {
            const fullUrl = href.startsWith('http') ? href : `https://www.fda.gov${href}`;
            const company = companyIntel.extractCompanyName(title.trim(), '', fullUrl, 'FDA Direct');
            
            results.push({
              id: crypto.randomBytes(16).toString('hex'),
              title: title.trim(),
              link: fullUrl,
              date: parseDate(dateText).toISOString(),
              dateFormatted: parseDate(dateText).toLocaleDateString(),
              source: 'FDA Website Direct',
              sourceCategory: 'official',
              sourceType: 'warning_letter',
              summary: '',
              company: company,
              types: ['warning_letter'],
              severity: CLASSIFIERS.warning_letter.severity,
              priority: 1
            });
          }
        });
        
        if (results.length > 0) break;
      }
    }
    
    console.log(`✅ FDA scraping: ${results.length} warning letters`);
  } catch (error) {
    console.error(`❌ FDA scraping error:`, error.message);
  }
  
  return results;
}

// Scrape Form 483s
async function scrapeFDA483s() {
  const results = [];
  
  try {
    console.log('🔍 Scraping FDA Form 483s...');
    
    const response = await axios.get(
      'https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/inspection-references/form-fda-483-frequently-asked-questions',
      {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      }
    );
    
    const $ = cheerio.load(response.data);



        // Look for links to Form 483 documents
    $('a[href*="483"]').each((i, elem) => {
      const $link = $(elem);
      const href = $link.attr('href');
      const text = $link.text();
      
      if (href && text && text.includes('483')) {
        const fullUrl = href.startsWith('http') ? href : `https://www.fda.gov${href}`;
        const company = companyIntel.extractCompanyName(text, '', fullUrl, 'FDA Direct');
        
        results.push({
          id: crypto.randomBytes(16).toString('hex'),
          title: text.trim(),
          link: fullUrl,
          date: new Date().toISOString(),
          dateFormatted: new Date().toLocaleDateString(),
          source: 'FDA Form 483 Page',
          sourceCategory: 'official',
          sourceType: 'form_483',
          summary: '',
          company: company,
          types: ['form_483'],
          severity: CLASSIFIERS.form_483.severity,
          priority: 1
        });
      }
    });
    
    console.log(`✅ FDA 483 scraping: ${results.length} items`);
  } catch (error) {
    console.error(`❌ FDA 483 scraping error:`, error.message);
  }
  
  return results;
}

// Parse date with multiple formats
function parseDate(dateText) {
  if (!dateText) return new Date();
  
  // Try various date formats
  const formats = [
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,  // MM/DD/YYYY
    /(\d{4})-(\d{2})-(\d{2})/,         // YYYY-MM-DD
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/,   // Month DD, YYYY
    /(\d{1,2})\s+(\w+)\s+(\d{4})/      // DD Month YYYY
  ];
  
  for (const format of formats) {
    const match = dateText.match(format);
    if (match) {
      const date = new Date(dateText);
      if (!isNaN(date)) return date;
    }
  }
  
  // Fallback to Date constructor
  const date = new Date(dateText);
  return isNaN(date) ? new Date() : date;
}

// Main aggregation function with all sources
async function aggregateAllSources() {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 Starting comprehensive data aggregation...');
  console.log('='.repeat(60) + '\n');
  
  const startTime = Date.now();
  const allItems = [];
  const errors = [];
  
  // 1. Scrape FDA directly
  console.log('📌 Phase 1: Direct FDA Scraping');
  const [warningLetters, form483s] = await Promise.all([
    scrapeFDAWarningLetters(),
    scrapeFDA483s()
  ]);
  allItems.push(...warningLetters, ...form483s);
  
  // 2. Fetch all RSS feeds
  console.log('\n📌 Phase 2: RSS Feed Collection');
  const allFeeds = [
    ...FEED_SOURCES.fda_official,
    ...FEED_SOURCES.trade_press,
    ...FEED_SOURCES.google_news
  ];
  
  // Add dynamic SEC feeds for watched companies
  const users = await WLUserLeaf.find({ 'watchedCompanies.0': { $exists: true } });
  users.forEach(user => {
    user.watchedCompanies.forEach(watched => {
      const company = companyIntel.companies.get(watched.name);
      if (company && company.ticker) {
        allFeeds.push({
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.ticker}&type=8-K&output=atom`,
          name: `SEC 8-K - ${watched.name}`,
          category: 'sec',
          type: 'filing',
          priority: 2
        });
      }
    });
  });
  
  // Process feeds in batches for better performance
  const batchSize = 5;
  for (let i = 0; i < allFeeds.length; i += batchSize) {
    const batch = allFeeds.slice(i, i + batchSize);
    const promises = batch.map(source => fetchFeed(source));
    const results = await Promise.all(promises);
    results.forEach(items => allItems.push(...items));
    
    // Progress indicator
    const progress = Math.min(100, Math.round((i + batchSize) / allFeeds.length * 100));
    console.log(`Progress: ${progress}%`);
  }
  
  // 3. Deduplicate and process
  console.log('\n📌 Phase 3: Data Processing & Deduplication');
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
  
  // 5. Save data
  console.log('\n📌 Phase 4: Saving Data');
  
  // Save all items
  await fs.writeFile(DATA_FILES.ALL_ITEMS, JSON.stringify(uniqueItems, null, 2));
  
  // Save by type
  const byType = {
    warning_letters: uniqueItems.filter(i => i.types.includes('warning_letter')),
    crls: uniqueItems.filter(i => i.types.includes('crl')),
    form_483s: uniqueItems.filter(i => i.types.includes('form_483'))
  };
  
  await Promise.all([
    fs.writeFile(DATA_FILES.WARNING_LETTERS, JSON.stringify(byType.warning_letters, null, 2)),
    fs.writeFile(DATA_FILES.CRL_LETTERS, JSON.stringify(byType.crls, null, 2)),
    fs.writeFile(DATA_FILES.FORM_483, JSON.stringify(byType.form_483s, null, 2))
  ]);
  
  // Save company data
  await companyIntel.save();
  
  // 6. Process notifications
  console.log('\n📌 Phase 5: Processing Notifications');
  if (newViolations.length > 0) {
    await processInstantNotifications(newViolations);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // 7. Generate summary
  const summary = {
    duration: `${elapsed}s`,
    total_items: uniqueItems.length,
    new_violations: newViolations.length,
    by_type: {
      warning_letters: byType.warning_letters.length,
      crls: byType.crls.length,
      form_483s: byType.form_483s.length,
      other: uniqueItems.length - byType.warning_letters.length - byType.crls.length - byType.form_483s.length
    },
    companies_tracked: companyIntel.companies.size,
    errors: errors.length
  };
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 Aggregation Complete:');
  console.log(`⏱️  Duration: ${summary.duration}`);
  console.log(`📑 Total items: ${summary.total_items}`);
  console.log(`🆕 New violations: ${summary.new_violations}`);
  console.log(`⚠️  Warning Letters: ${summary.by_type.warning_letters}`);
  console.log(`🚫 CRLs: ${summary.by_type.crls}`);
  console.log(`📋 Form 483s: ${summary.by_type.form_483s}`);
  console.log(`🏢 Companies tracked: ${summary.companies_tracked}`);
  if (errors.length > 0) {
    console.log(`❌ Errors: ${errors.length}`);
  }
  console.log('='.repeat(60) + '\n');
  
  return summary;
}

// Process instant notifications
async function processInstantNotifications(newViolations) {
  try {
    const users = await WLUserLeaf.find({ 'notificationPrefs.instant': true });
    
    for (const user of users) {
      const relevantViolations = newViolations.filter(violation => {
        // Check if user is watching this company
        if (user.watchedCompanies.length > 0) {
          const companyName = companyIntel.findCanonicalName(violation.company);
          const isWatched = user.watchedCompanies.some(wc => 
            companyIntel.findCanonicalName(wc.name) === companyName
          );
          if (!isWatched) return false;
        }
        
        // Check if critical only
        if (user.notificationPrefs.criticalOnly && violation.severity < 8) {
          return false;
        }
        
        return true;
      });
      
      if (relevantViolations.length > 0) {
        await sendInstantNotificationEmail(user, relevantViolations);
      }
    }
  } catch (error) {
    console.error('Error processing instant notifications:', error);
  }
}

// Send instant notification email
async function sendInstantNotificationEmail(user, violations) {
  if (!emailTransporter) return;
  
  const emails = [user.email, ...user.reportEmails];
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a202c; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
        .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
        .violation { background: #f7fafc; padding: 15px; margin: 15px 0; border-left: 4px solid #4299e1; border-radius: 5px; }
        .severity { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; }
        .severity-high { background: #feb2b2; color: #742a2a; }
        .severity-critical { background: #fc8181; color: #742a2a; }
        .severity-medium { background: #fbd38d; color: #744210; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #718096; }
        a { color: #4299e1; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; font-size: 24px;">🚨 FDA Regulatory Alert</h1>
          <p style="margin: 10px 0 0 0; opacity: 0.9;">${violations.length} new action${violations.length !== 1 ? 's' : ''} detected</p>
        </div>
        <div class="content">
          ${violations.map(v => {
            const classifier = CLASSIFIERS[v.types[0]];
            const severityClass = v.severity >= 9 ? 'severity-critical' : v.severity >= 7 ? 'severity-high' : 'severity-medium';
            return `
              <div class="violation">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                  <h3 style="margin: 0; color: #2d3748;">${v.company}</h3>
                  <span class="severity ${severityClass}">${v.types[0].replace(/_/g, ' ').toUpperCase()}</span>
                </div>
                <p style="margin: 5px 0; color: #4a5568;"><strong>Date:</strong> ${new Date(v.date).toLocaleDateString()}</p>
                <p style="margin: 5px 0; color: #4a5568;"><strong>Title:</strong> ${v.title}</p>
                ${v.summary ? `<p style="margin: 5px 0; color: #4a5568;"><strong>Summary:</strong> ${v.summary.substring(0, 200)}...</p>` : ''}
                ${classifier ? `<p style="margin: 5px 0; color: #4a5568;"><strong>Timeline:</strong> ${classifier.typical_timeline}</p>` : ''}
                <a href="${v.link}" style="display: inline-block; margin-top: 10px;">View Full Details →</a>
              </div>
            `;
          }).join('')}
          
          <div style="background: #edf2f7; padding: 15px; border-radius: 5px; margin-top: 20px;">
            <h4 style="margin: 0 0 10px 0; color: #2d3748;">Quick Actions</h4>
            <p style="margin: 5px 0; color: #4a5568;">• Review the full regulatory action details</p>
            <p style="margin: 5px 0; color: #4a5568;">• Contact the affected company's regulatory affairs team</p>
            <p style="margin: 5px 0; color: #4a5568;">• Update your compliance tracking systems</p>
          </div>
        </div>
        <div class="footer">
          <p>You received this alert because instant notifications are enabled in your FDA Monitor settings.</p>
          <p>To manage your preferences, visit the dashboard at <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}">${process.env.DASHBOARD_URL || 'http://localhost:3000'}</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  for (const email of emails) {
    try {
      await emailTransporter.sendMail({
        from: API_KEYS.SMTP_USER,
        to: email,
        subject: `🚨 FDA Alert: ${violations.length} New Regulatory Action${violations.length !== 1 ? 's' : ''}`,
        html: html
      });
      console.log(`✅ Instant notification sent to ${email}`);
    } catch (error) {
      console.error(`❌ Failed to send notification to ${email}:`, error.message);
    }
  }
}

// Weekly digest generation
async function generateWeeklyDigest(user) {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
  const items = JSON.parse(allData);
  const recentItems = items.filter(item => new Date(item.date) >= oneWeekAgo);
  
  // Filter based on user preferences
  let relevantItems = recentItems;
  if (user.watchedCompanies.length > 0) {
    relevantItems = recentItems.filter(item => {
      const companyName = companyIntel.findCanonicalName(item.company);
      return user.watchedCompanies.some(wc => 
        companyIntel.findCanonicalName(wc.name) === companyName
      );
    });
  }
  
  const byType = {
    warning_letters: relevantItems.filter(i => i.types.includes('warning_letter')),
    crls: relevantItems.filter(i => i.types.includes('crl')),
    form_483s: relevantItems.filter(i => i.types.includes('form_483')),
    other: relevantItems.filter(i => 
      !i.types.includes('warning_letter') && 
      !i.types.includes('crl') && 
      !i.types.includes('form_483')
    )
  };
  
  // Get company metrics
  const companyMetrics = companyIntel.metrics;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a202c; background: #f7fafc; }
        .container { max-width: 800px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; }
        .header h1 { margin: 0; font-size: 28px; }
        .header p { margin: 10px 0 0 0; opacity: 0.9; }
        .content { padding: 40px; }
        .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; margin: 30px 0; }
        .summary-card { background: #f7fafc; padding: 20px; border-radius: 8px; text-align: center; }
        .summary-card .number { font-size: 32px; font-weight: bold; color: #4299e1; }
        .summary-card .label { font-size: 14px; color: #718096; margin-top: 5px; }
        .section { margin: 30px 0; }
        .section-header { font-size: 20px; font-weight: bold; color: #2d3748; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #e2e8f0; }
        .item { background: #f7fafc; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 3px solid #4299e1; }
        .item-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px; }
        .item-company { font-weight: bold; color: #2d3748; }
        .item-type { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; background: #bee3f8; color: #2c5282; }
        .item-meta { font-size: 13px; color: #718096; margin: 5px 0; }
        .top-violators { background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .violator-item { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #feb2b2; }
        .violator-item:last-child { border-bottom: none; }
        .footer { background: #f7fafc; padding: 30px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; }
        a { color: #4299e1; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📊 FDA Weekly Intelligence Report</h1>
          <p>${new Date(oneWeekAgo).toLocaleDateString()} - ${new Date().toLocaleDateString()}</p>
        </div>
        
        <div class="content">
          <div class="summary-grid">
            <div class="summary-card">
              <div class="number">${relevantItems.length}</div>
              <div class="label">Total Actions</div>
            </div>
            <div class="summary-card">
              <div class="number">${byType.warning_letters.length}</div>
              <div class="label">Warning Letters</div>
            </div>
            <div class="summary-card">
              <div class="number">${byType.crls.length}</div>
              <div class="label">CRLs</div>
            </div>
            <div class="summary-card">
              <div class="number">${byType.form_483s.length}</div>
              <div class="label">Form 483s</div>
            </div>
          </div>
          
          ${companyMetrics.topViolators && companyMetrics.topViolators.length > 0 ? `
            <div class="top-violators">
              <h3 style="margin: 0 0 15px 0; color: #742a2a;">⚠️ Companies with Most Violations</h3>
              ${companyMetrics.topViolators.slice(0, 5).map(company => `
                <div class="violator-item">
                  <span style="font-weight: bold;">${company.name}</span>
                  <span style="color: #742a2a;">${company.violations} violations • Risk: ${company.risk_score}/100</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
          
          ${byType.warning_letters.length > 0 ? `
            <div class="section">
              <div class="section-header">⚠️ Warning Letters</div>
              ${byType.warning_letters.slice(0, 10).map(item => `
                <div class="item">
                  <div class="item-header">
                    <span class="item-company">${item.company}</span>
                    <span class="item-type">WARNING LETTER</span>
                  </div>
                  <div class="item-meta">${new Date(item.date).toLocaleDateString()} • ${item.source}</div>
                  <div style="margin: 8px 0;">${item.title}</div>
                  <a href="${item.link}">View Details →</a>
                </div>
              `).join('')}
              ${byType.warning_letters.length > 10 ? `
                <p style="text-align: center; margin-top: 20px; color: #718096;">
                  ... and ${byType.warning_letters.length - 10} more warning letters
                </p>
              ` : ''}
            </div>
          ` : ''}
          
          ${byType.crls.length > 0 ? `
            <div class="section">
              <div class="section-header">🚫 Complete Response Letters</div>
              ${byType.crls.map(item => `
                <div class="item" style="border-left-color: #f56565;">
                  <div class="item-header">
                    <span class="item-company">${item.company}</span>
                    <span class="item-type" style="background: #fed7d7; color: #742a2a;">CRL</span>
                  </div>
                  <div class="item-meta">${new Date(item.date).toLocaleDateString()} • ${item.source}</div>
                  <div style="margin: 8px 0;">${item.title}</div>
                  <a href="${item.link}">View Details →</a>
                </div>
              `).join('')}
            </div>
          ` : ''}
          
          ${byType.form_483s.length > 0 ? `
            <div class="section">
              <div class="section-header">📋 Form 483 Observations</div>
              ${byType.form_483s.slice(0, 10).map(item => `
                <div class="item" style="border-left-color: #ed8936;">
                  <div class="item-header">
                    <span class="item-company">${item.company}</span>
                    <span class="item-type" style="background: #feebc8; color: #7c2d12;">FORM 483</span>
                  </div>
                  <div class="item-meta">${new Date(item.date).toLocaleDateString()} • ${item.source}</div>
                  <div style="margin: 8px 0;">${item.title}</div>
                  <a href="${item.link}">View Details →</a>
                </div>
              `).join('')}
              ${byType.form_483s.length > 10 ? `
                <p style="text-align: center; margin-top: 20px; color: #718096;">
                  ... and ${byType.form_483s.length - 10} more Form 483s
                </p>
              ` : ''}
            </div>
          ` : ''}
          
          <div style="background: #edf2f7; padding: 20px; border-radius: 8px; margin-top: 30px;">
            <h3 style="margin: 0 0 15px 0; color: #2d3748;">📈 Week at a Glance</h3>
            <ul style="margin: 0; padding-left: 20px; color: #4a5568;">
              <li>Total companies tracked: ${companyMetrics.totalCompanies}</li>
              <li>Average compliance score: ${Math.round(
                Array.from(companyIntel.companies.values())
                  .reduce((sum, c) => sum + c.compliance_score, 0) / companyIntel.companies.size
              )}/100</li>
              <li>Most common violation type: ${
                Object.entries(
                  relevantItems.reduce((acc, item) => {
                    item.types.forEach(type => {
                      acc[type] = (acc[type] || 0) + 1;
                    });
                    return acc;
                  }, {})
                ).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/_/g, ' ') || 'N/A'
              }</li>
            </ul>
          </div>
        </div>
        
        <div class="footer">
          <p><strong>FDA Regulatory Intelligence System</strong></p>
          <p>This weekly digest was generated on ${new Date().toLocaleString()} for ${user.email}</p>
          <p>To manage your subscription preferences or update your watched companies, visit your dashboard.</p>
          <p style="margin-top: 15px;">
            <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}">Dashboard</a> • 
            <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}/settings">Settings</a> • 
            <a href="mailto:${API_KEYS.SMTP_USER}">Contact Support</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const emails = [user.email, ...user.reportEmails];
  
  for (const email of emails) {
    try {
      await emailTransporter.sendMail({
        from: API_KEYS.SMTP_USER,
        to: email,
        subject: `📊 FDA Weekly Report: ${relevantItems.length} Regulatory Actions`,
        html: html
      });
      console.log(`✅ Weekly digest sent to ${email}`);
    } catch (error) {
      console.error(`❌ Failed to send weekly digest to ${email}:`, error.message);
    }
  }
}

// API Routes

// Initialize storage
async function initStorage() {
  await ensureDirectories();
  
  for (const file of Object.values(DATA_FILES)) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]');
      console.log(`Created: ${file}`);
    }
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      mongodb: mongoose.connection.readyState === 1,
      email: emailTransporter !== null,
      openai: openai !== null
    }
  });
});

// Get items with advanced filtering
app.get('/api/items', async (req, res) => {
  try {
    const { 
      type, 
      source, 
      days = 30, 
      company,
      severity_min,
      limit = 200,
      offset = 0,
      sort = 'date'
    } = req.query;
    
    let data = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
    let items = JSON.parse(data);
    
    // Apply filters
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));
    items = items.filter(item => new Date(item.date) >= cutoff);
    
    if (type) {
      items = items.filter(item => item.types.includes(type));
    }
    
    if (source) {
      items = items.filter(item => item.sourceCategory === source);
    }
    
    if (company) {
      const normalized = companyIntel.findCanonicalName(company);
      items = items.filter(item => 
        companyIntel.findCanonicalName(item.company) === normalized
      );
    }
    
    if (severity_min) {
      items = items.filter(item => item.severity >= parseInt(severity_min));
    }
    
    // Sort
    if (sort === 'severity') {
      items.sort((a, b) => b.severity - a.severity);
    } else if (sort === 'company') {
      items.sort((a, b) => a.company.localeCompare(b.company));
    } else {
      items.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    
    // Paginate
    const total = items.length;
    items = items.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    res.json({
      success: true,
      total: total,
      count: items.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
      items: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get company details with all data
app.get('/api/company/:name', async (req, res) => {
  try {
    const companyName = decodeURIComponent(req.params.name);
    const canonical = companyIntel.findCanonicalName(companyName);
    
    const company = companyIntel.companies.get(canonical);
    if (!company) {
      return res.status(404).json({ 
        success: false, 
        error: 'Company not found' 
      });
    }
    
    // Get all related items
    const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
    const items = JSON.parse(allData);
    const relatedItems = items.filter(item => 
      companyIntel.findCanonicalName(item.company) === canonical
    );
    
    // Get contacts
    const contacts = await companyIntel.findContactsForCompany(canonical);
    
    res.json({
      success: true,
      company: {
        ...company,
        aliases: Array.from(company.aliases || []),
        products: Array.from(company.products || []),
        facilities: Array.from(company.facilities || [])
      },
      contacts: contacts,
      relatedItems: relatedItems,
      metrics: {
        total_violations: company.violations.length,
        risk_score: company.risk_score,
        compliance_score: company.compliance_score,
        recent_violations: company.violations.filter(v => {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          return new Date(v.date) > thirtyDaysAgo;
        }).length
      }
    });
  } catch (error) {
    console.error('Company lookup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Enhancement endpoint
// app.post('/api/ai/enhance', async (req, res) => {
//   try {
//     const { sourceItemId } = req.body;
    
//     // Get the item
//     const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
//     const items = JSON.parse(allData);
//     const item = items.find(i => i.id === sourceItemId);
    
//     if (!item) {
//       return res.status(404).json({ success: false, error: 'Item not found' });
//     }
    
//     // Check cache
//     if (companyIntel.aiCache.has(item.company)) {
//       return res.json({
//         success: true,
//         cached: true,
//         ...companyIntel.aiCache.get(item.company)
//       });
//     }
    
//     if (!openai) {
//       // Fallback response without AI
//       const contacts = await companyIntel.findContactsForCompany(item.company);
//       return res.json({
//         success: true,
//         fallback: true,
//         canonical_company_name: companyIntel.findCanonicalName(item.company),
//         summary: item.summary || 'No AI summary available',
//         public_context: '',
//         precedent_refs: [],
//         emails: contacts?.emails?.map(e => e.email) || []
//       });
//     }
    
//     // Use OpenAI
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4-turbo-preview",
//       messages: [
//         {
//           role: "system",
//           content: `You are an FDA regulatory expert. Analyze the provided FDA action and return a JSON response with:
//             - canonical_company_name: The official registered company name
//             - summary: Clear summary of the regulatory action (2-3 sentences)
//             - public_context: Any relevant public context about this company's regulatory history
//             - precedent_refs: Array of similar FDA precedents or related cases
//             - emails: Array of any publicly available regulatory/quality contact emails`
//         },
//         {
//           role: "user",
//           content: `Analyze this FDA action:
//             Title: ${item.title}
//             Company: ${item.company}
//             Type: ${item.types.join(', ')}
//             Date: ${item.date}
//             Link: ${item.link}
//             Content: ${item.summary}
            
//             Return only valid JSON.`
//         }
//       ],
//       temperature: 0.3,
//       max_tokens: 1000,
//       response_format: { type: "json_object" }
//     });
    
//     let aiData;
//     try {
//       aiData = JSON.parse(completion.choices[0].message.content);
//     } catch {
//       aiData = {
//         canonical_company_name: companyIntel.findCanonicalName(item.company),
//         summary: completion.choices[0].message.content,
//         public_context: '',
//         precedent_refs: [],
//         emails: []
//       };
//     }
    
//     // Cache the result
//     companyIntel.aiCache.set(item.company, aiData);
//     await companyIntel.save();
    
//     // Update company alias if different
//     if (aiData.canonical_company_name && aiData.canonical_company_name !== item.company) {
//       companyIntel.companyAliases.set(
//         companyIntel.normalizeForMatching(item.company),
//         aiData.canonical_company_name
//       );
//     }
    
//     // Merge with contact search
//     const contacts = await companyIntel.findContactsForCompany(aiData.canonical_company_name || item.company);
//     if (contacts && contacts.emails) {
//       const contactEmails = contacts.emails.map(e => e.email);
//       aiData.emails = [...new Set([...aiData.emails, ...contactEmails])];
//     }
    
//     res.json({
//       success: true,
//       ...aiData
//     });
    
//   } catch (error) {
//     console.error('AI enhancement error:', error);
//     res.status(500).json({ 
//       success: false, 
//       error: error.message,
//       fallback: {
//         canonical_company_name: companyIntel.findCanonicalName(req.body.company || ''),
//         summary: 'AI enhancement unavailable',
//         public_context: '',
//         precedent_refs: [],
//         emails: []
//       }
//     });
//   }
// });
// Replace the existing /api/ai/enhance endpoint
// app.post('/api/ai/enhance', async (req, res) => {
//   try {
//     const { sourceItemId, title, link, summary, source } = req.body;
    
//     // Build a more comprehensive prompt for AI
//     const promptContent = `${title || ''}\n${summary || ''}\nSource: ${source || ''}\nLink: ${link || ''}`;
    
//     if (!openai) {
//       // Fallback without AI
//       return res.json({
//         success: true,
//         fallback: true,
//         canonical_company_name: 'Unknown Company',
//         summary: summary || 'No AI summary available',
//         public_context: '',
//         precedent_refs: [],
//         emails: []
//       });
//     }
    
//     // Use OpenAI to extract company and enhance data
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4-turbo-preview",
//       messages: [
//         {
//           role: "system",
//           content: `You are an FDA regulatory expert. Analyze the provided FDA action and return a JSON response with:
//             - canonical_company_name: Extract the actual company name from the text (be very careful and accurate)
//             - summary: Clear, detailed summary of the regulatory action (3-4 sentences)
//             - public_context: Any relevant public context about this company's regulatory history
//             - regulatory_impact: Specific regulatory implications
//             - business_impact: Business and market implications
//             - precedent_refs: Array of similar FDA precedents or related cases
//             - action_required: What the company needs to do
//             - timeline: Response timeline if mentioned`
//         },
//         {
//           role: "user",
//           content: `Analyze this FDA action and extract the company name:\n\n${promptContent}\n\nReturn only valid JSON.`
//         }
//       ],
//       temperature: 0.3,
//       max_tokens: 1500,
//       response_format: { type: "json_object" }
//     });
    
//     let aiData;
//     try {
//       aiData = JSON.parse(completion.choices[0].message.content);
//     } catch {
//       aiData = {
//         canonical_company_name: 'Unknown Company',
//         summary: 'Unable to parse AI response',
//         public_context: '',
//         precedent_refs: [],
//         emails: []
//       };
//     }
    
//     // Now search for contacts with the extracted company name
//     let allEmails = [];
//     if (aiData.canonical_company_name && aiData.canonical_company_name !== 'Unknown Company') {
//       const contacts = await companyIntel.findContactsForCompany(aiData.canonical_company_name);
      
//       if (contacts) {
//         // Collect all emails from different sources
//         if (contacts.emails && contacts.emails.length > 0) {
//           allEmails = allEmails.concat(contacts.emails.map(e => e.email || e));
//         }
//         if (contacts.regulatory_contacts && contacts.regulatory_contacts.length > 0) {
//           allEmails = allEmails.concat(contacts.regulatory_contacts.filter(c => c.email).map(c => c.email));
//         }
//         if (contacts.executives && contacts.executives.length > 0) {
//           allEmails = allEmails.concat(contacts.executives.filter(e => e.email).map(e => e.email));
//         }
//         if (contacts.general_email) {
//           allEmails.push(contacts.general_email);
//         }
        
//         // Add contact details to response
//         aiData.contacts = contacts;
//       }
//     }
    
//     // Remove duplicates
//     aiData.emails = [...new Set(allEmails)];
    
//     res.json({
//       success: true,
//       ...aiData
//     });
    
//   } catch (error) {
//     console.error('AI enhancement error:', error);
//     res.status(500).json({ 
//       success: false, 
//       error: error.message,
//       fallback: {
//         canonical_company_name: 'Unknown Company',
//         summary: 'AI enhancement unavailable',
//         public_context: '',
//         precedent_refs: [],
//         emails: []
//       }
//     });
//   }
// });



// Export modal to email
app.post('/api/report/export-modal', async (req, res) => {
  try {
    const { html, toEmail } = req.body;
    
    if (!toEmail || !html) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and HTML content required' 
      });
    }
    
    if (!emailTransporter) {
      return res.status(500).json({ 
        success: false, 
        error: 'Email service not configured' 
      });
    }
    
    await emailTransporter.sendMail({
      from: API_KEYS.SMTP_USER,
      to: toEmail,
      subject: 'FDA Regulatory Intelligence - Exported Report',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a202c; }
            .container { max-width: 800px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
            .content { background: #f8f9fa; padding: 30px; border-radius: 10px; }
            h1 { margin: 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>FDA Regulatory Intelligence Report</h1>
              <p>Exported on ${new Date().toLocaleString()}</p>
            </div>
            <div class="content">
              ${html}
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #718096;">
              <p>This report was generated by the FDA Regulatory Intelligence System</p>
              <p>For questions or support, contact: ${API_KEYS.SMTP_USER}</p>
            </div>
          </div>
        </body>
        </html>
      `
    });
    
    // Log the export
    await AuditLog.create({
      action: 'report_exported',
      details: { toEmail, timestamp: new Date() }
    });
    
    res.json({ 
      success: true, 
      message: `Report sent to ${toEmail}` 
    });
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// WLUSERLEAF endpoints
app.get('/api/user/wluserleaf', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (email) {
      const user = await WLUserLeaf.findOne({ email });
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
      }
      res.json({ success: true, user });
    } else {
      const users = await WLUserLeaf.find().select('-apiKeys');
      res.json({ success: true, users });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.put('/api/user/wluserleaf', async (req, res) => {
  try {
    const { email, ...updates } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email required' 
      });
    }
    
    let user = await WLUserLeaf.findOne({ email });
    
    if (!user) {
      user = new WLUserLeaf({ email, ...updates });
    } else {
      Object.assign(user, updates);
      user.updatedAt = new Date();
    }
    
    await user.save();
    
    // Log the update
    await AuditLog.create({
      userId: user._id,
      action: 'settings_updated',
      details: updates
    });
    
    res.json({
      success: true,
      user: user
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add company to watchlist
app.post('/api/user/watch-company', async (req, res) => {
  try {
    const { email, company, alertLevel = 'all', customRules = {} } = req.body;
    
    const user = await WLUserLeaf.findOne({ email });
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    // Check if already watching
    const existing = user.watchedCompanies.findIndex(wc => 
      companyIntel.findCanonicalName(wc.name) === companyIntel.findCanonicalName(company)
    );
    
    if (existing >= 0) {
      // Update existing
      user.watchedCompanies[existing] = {
        name: company,
        addedAt: user.watchedCompanies[existing].addedAt,
        alertLevel,
        customRules
      };
    } else {
      // Add new
      user.watchedCompanies.push({
        name: company,
        addedAt: new Date(),
        alertLevel,
        customRules
      });
    }
    
    await user.save();
    
    res.json({
      success: true,
      message: `${company} added to watchlist`,
      watchedCompanies: user.watchedCompanies
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Remove company from watchlist
app.delete('/api/user/watch-company', async (req, res) => {
  try {
    const { email, company } = req.body;
    
    const user = await WLUserLeaf.findOne({ email });
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    user.watchedCompanies = user.watchedCompanies.filter(wc => 
      companyIntel.findCanonicalName(wc.name) !== companyIntel.findCanonicalName(company)
    );
    
    await user.save();
    
    res.json({
      success: true,
      message: `${company} removed from watchlist`,
      watchedCompanies: user.watchedCompanies
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Send digest now
app.post('/api/user/send-digest-now', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await WLUserLeaf.findOne({ email });
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    await generateWeeklyDigest(user);
    
    res.json({
      success: true,
      message: `Digest sent to ${user.email} and ${user.reportEmails.length} additional recipients`
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get dashboard metrics
app.get('/api/metrics', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
    const items = JSON.parse(allData);
    const recentItems = items.filter(item => new Date(item.date) >= thirtyDaysAgo);
    
    // Calculate metrics
    const metrics = {
      summary: {
        total_items: recentItems.length,
        total_companies: companyIntel.companies.size,
        warning_letters: recentItems.filter(i => i.types.includes('warning_letter')).length,
        crls: recentItems.filter(i => i.types.includes('crl')).length,
        form_483s: recentItems.filter(i => i.types.includes('form_483')).length,
        other: recentItems.filter(i => 
          !i.types.includes('warning_letter') && 
          !i.types.includes('crl') && 
          !i.types.includes('form_483')
        ).length
      },
      trends: companyIntel.metrics.violationTrends,
      top_companies: companyIntel.metrics.topViolators,
      compliance_distribution: companyIntel.metrics.complianceDistribution,
      by_source: {},
      by_severity: {
        critical: recentItems.filter(i => i.severity >= 9).length,
        high: recentItems.filter(i => i.severity >= 7 && i.severity < 9).length,
        medium: recentItems.filter(i => i.severity >= 5 && i.severity < 7).length,
        low: recentItems.filter(i => i.severity < 5).length
      },
      recent_updates: recentItems.slice(0, 10).map(item => ({
        date: item.date,
        company: item.company,
        type: item.types[0],
        severity: item.severity,
        title: item.title
      }))
    };
    
    // Count by source
    recentItems.forEach(item => {
      metrics.by_source[item.sourceCategory] = (metrics.by_source[item.sourceCategory] || 0) + 1;
    });
    
    res.json({
      success: true,
      metrics: metrics
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Search endpoint with advanced matching
app.get('/api/search', async (req, res) => {
  try {
    const { q, type = 'all', limit = 50 } = req.query;
    
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query required' 
      });
    }
    
    const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
    let items = JSON.parse(allData);
    
    const query = q.toLowerCase();
    
    // Search in different fields based on type
    if (type === 'company') {
      items = items.filter(item => 
        item.company.toLowerCase().includes(query)
      );
    } else if (type === 'title') {
      items = items.filter(item => 
        item.title.toLowerCase().includes(query)
      );
    } else {
      // Search all fields
      items = items.filter(item => 
        item.company.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        (item.summary && item.summary.toLowerCase().includes(query)) ||
        item.types.some(t => t.includes(query))
      );
    }
    
    // Sort by relevance (basic scoring)
    items.forEach(item => {
      let score = 0;
      if (item.company.toLowerCase() === query) score += 10;
      else if (item.company.toLowerCase().includes(query)) score += 5;
      if (item.title.toLowerCase().includes(query)) score += 3;
      if (item.summary && item.summary.toLowerCase().includes(query)) score += 1;
      item.relevanceScore = score;
    });
    
    items.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    res.json({
      success: true,
      query: q,
      total: items.length,
      items: items.slice(0, parseInt(limit))
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Refresh data endpoint
app.post('/api/refresh', async (req, res) => {
  try {
    const { force = false } = req.body;
    
    // Check if refresh is already running
    if (global.refreshInProgress && !force) {
      return res.json({
        success: false,
        message: 'Refresh already in progress'
      });
    }
    
    global.refreshInProgress = true;
    
    const stats = await aggregateAllSources();
    
    global.refreshInProgress = false;
    
    res.json({
      success: true,
      message: 'Data refreshed successfully',
      stats: stats
    });
    
  } catch (error) {
    global.refreshInProgress = false;
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get classification info
app.get('/api/classifiers', (req, res) => {
  res.json({
    success: true,
    classifiers: CLASSIFIERS
  });
});

// Audit log endpoint
app.get('/api/audit-log', async (req, res) => {
  try {
    const { userId, limit = 100, offset = 0 } = req.query;
    
    const query = userId ? { userId } : {};
    
    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .populate('userId', 'email');
    
    const total = await AuditLog.countDocuments(query);
    
    res.json({
      success: true,
      total,
      logs
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Backup endpoint
app.post('/api/backup', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(BACKUP_DIR, timestamp);
    
    await fs.mkdir(backupDir, { recursive: true });
    
    // Copy all data files
    for (const [name, filepath] of Object.entries(DATA_FILES)) {
      try {
        const data = await fs.readFile(filepath);
        await fs.writeFile(path.join(backupDir, path.basename(filepath)), data);
      } catch (error) {
        console.error(`Error backing up ${name}:`, error.message);
      }
    }
    
    // Export MongoDB data
    const users = await WLUserLeaf.find().select('-apiKeys');
    await fs.writeFile(
      path.join(backupDir, 'users.json'), 
      JSON.stringify(users, null, 2)
    );
    
    const auditLogs = await AuditLog.find().limit(10000);
    await fs.writeFile(
      path.join(backupDir, 'audit.json'), 
      JSON.stringify(auditLogs, null, 2)
    );
    
    res.json({
      success: true,
      message: `Backup created: ${timestamp}`,
      location: backupDir
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Schedule tasks
function setupScheduledTasks() {
  // Data refresh every 30 minutes
  cron.schedule('*/300 * * * *', async () => {
    if (!global.refreshInProgress) {
      console.log('\n⏰ Scheduled data refresh starting...');
      try {
        await aggregateAllSources();
      } catch (error) {
        console.error('Scheduled refresh error:', error);
      }
    }
  });
  
  // Weekly digests - check every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const now = moment().tz('Europe/London');
      const currentDay = now.day();
      const currentHour = now.hour();
      
      const users = await WLUserLeaf.find({
        'notificationPrefs.weekly': true,
        digestDayOfWeek: currentDay,
        digestHour: currentHour
      });
      
      console.log(`Checking weekly digests: ${users.length} users qualify`);
      
      for (const user of users) {
        try {
          await generateWeeklyDigest(user);
        } catch (error) {
          console.error(`Error sending digest to ${user.email}:`, error);
        }
      }
    } catch (error) {
      console.error('Weekly digest cron error:', error);
    }
  });
  
  // Daily digests
  cron.schedule('0 * * * *', async () => {
    try {
      const now = moment().tz('Europe/London');
      const currentHour = now.hour();
      
      const users = await WLUserLeaf.find({
        'notificationPrefs.daily': true,
        digestHour: currentHour
      });
      
      console.log(`Checking daily digests: ${users.length} users qualify`);
      
      for (const user of users) {
        try {
          const oneDayAgo = new Date();
          oneDayAgo.setDate(oneDayAgo.getDate() - 1);
          
          const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
          const items = JSON.parse(allData);
          const recentItems = items.filter(item => new Date(item.date) >= oneDayAgo);
          
          if (recentItems.length > 0) {
            await sendDailyDigest(user, recentItems);
          }
        } catch (error) {
          console.error(`Error sending daily digest to ${user.email}:`, error);
        }
      }
    } catch (error) {
      console.error('Daily digest cron error:', error);
    }
  });
  
  // Backup every day at 2 AM
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('Running daily backup...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(BACKUP_DIR, timestamp);
      
      await fs.mkdir(backupDir, { recursive: true });
      
      for (const [name, filepath] of Object.entries(DATA_FILES)) {
        try {
          const data = await fs.readFile(filepath);
          await fs.writeFile(path.join(backupDir, path.basename(filepath)), data);
        } catch (error) {
          console.error(`Backup error for ${name}:`, error.message);
        }
      }
      
      console.log(`Backup completed: ${backupDir}`);
      
      // Clean old backups (keep last 30 days)
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const backups = await fs.readdir(BACKUP_DIR);
      
      for (const backup of backups) {
        const backupPath = path.join(BACKUP_DIR, backup);
        const stats = await fs.stat(backupPath);
        if (stats.mtime.getTime() < thirtyDaysAgo) {
          await fs.rm(backupPath, { recursive: true });
          console.log(`Deleted old backup: ${backup}`);
        }
      }
    } catch (error) {
      console.error('Backup task error:', error);
    }
  });
  
  console.log('✅ Scheduled tasks configured');
}
// COMPLETE REPLACEMENT FOR /api/ai/enhance endpoint
app.post('/api/ai/enhance', async (req, res) => {
  try {
    const { itemId, title, link, summary, source, types, date, warningLetterData } = req.body;
    
    console.log('\n🤖 AI Enhancement Request:');
    console.log('Title:', title?.substring(0, 100));
    console.log('Has OpenAI:', !!openai);
    
    // Check if we have warning letter data
    if (warningLetterData) {
      console.log('📋 Warning Letter Data Received:');
      console.log('  - Company:', warningLetterData.company || warningLetterData.companyName);
      console.log('  - Letter content length:', warningLetterData.letterContent?.length || 0);
      console.log('  - Violations count:', warningLetterData.violations?.length || 0);
      console.log('  - Products count:', warningLetterData.products?.length || 0);
      console.log('  - Response deadline:', warningLetterData.responseDeadline);
    }
    
    // Build comprehensive content for analysis INCLUDING warning letter data
    let fullContent = `
Title: ${title || 'No title'}
Date: ${date || 'Unknown date'}
Source: ${source || 'Unknown source'}
Types: ${types?.join(', ') || 'Unknown type'}
Link: ${link || 'No link'}
Summary: ${summary || 'No summary available'}`;

    // Add warning letter specific content if available
    if (warningLetterData) {
      fullContent += `

DETAILED WARNING LETTER INFORMATION:
Company: ${warningLetterData.company || warningLetterData.companyName || 'Unknown'}
${warningLetterData.recipient ? `
Recipient Name: ${warningLetterData.recipient.name || 'Not specified'}
Recipient Title: ${warningLetterData.recipient.title || 'Not specified'}
Recipient Email: ${warningLetterData.recipient.email || 'Not specified'}
Address: ${warningLetterData.recipient.fullAddress || 'Not specified'}` : ''}

Letter Date: ${warningLetterData.letterDate || 'Not specified'}
Response Deadline: ${warningLetterData.responseDeadline || 'Not specified'}
MARCS Number: ${warningLetterData.marcsNumber || 'Not specified'}
Issuing Office: ${warningLetterData.issuingOffice || 'Not specified'}
Product Type: ${warningLetterData.productType || 'Not specified'}
Delivery Method: ${warningLetterData.deliveryMethod || 'Not specified'}
FEI Number: ${warningLetterData.feiNumber || 'Not specified'}
Subject: ${warningLetterData.subject || 'Not specified'}

Response Email: ${warningLetterData.responseEmail || 'Not specified'}
Response Address: ${warningLetterData.responseAddress || 'Not specified'}

Violations (${warningLetterData.violations?.length || 0} total):
${warningLetterData.violations?.map((v, i) => `${i+1}. ${v}`).join('\n') || 'None listed'}

Products Mentioned:
${warningLetterData.products?.join(', ') || 'None listed'}

Full Letter Content (${warningLetterData.letterContent?.length || 0} characters):
${warningLetterData.letterContent || 'Not available'}`;
    }
    
    fullContent = fullContent.trim();
    
    let aiResult = {
      canonical_company_name: 'Unknown Company',
      summary: summary || 'No summary available',
      emails: [],
      contacts: [],
      regulatory_impact: '',
      business_impact: '',
      action_required: '',
      timeline: '',
      severity_assessment: 5,
      key_violations: [],
      response_strategy: '',
      compliance_recommendations: ''
    };
    
    // If we have the company from warning letter, use it directly
    if (warningLetterData?.company || warningLetterData?.companyName || warningLetterData?.recipient?.company) {
      aiResult.canonical_company_name = 
        warningLetterData.company || 
        warningLetterData.companyName || 
        warningLetterData.recipient?.company;
      console.log('📊 Using company from warning letter:', aiResult.canonical_company_name);
    }
    
    // Try AI extraction if available
    if (openai) {
      try {
        console.log('🔮 Calling OpenAI with full content...');
        console.log('Content length being sent to AI:', fullContent.length);
        
        // Split into chunks if content is too long
        const MAX_CONTENT_LENGTH = 30000; // Adjust based on your needs
        let contentToAnalyze = fullContent;
        
        if (fullContent.length > MAX_CONTENT_LENGTH) {
          // Prioritize key information
          contentToAnalyze = fullContent.substring(0, MAX_CONTENT_LENGTH);
          console.log('⚠️ Content truncated to', MAX_CONTENT_LENGTH, 'characters');
        }
        
        const completion = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: [
            {
              role: "system",
              content: `You are an FDA regulatory expert specializing in warning letters and compliance. Analyze the provided FDA warning letter and regulatory documents.
              
CRITICAL INSTRUCTIONS:
1. Extract the ACTUAL company name (not FDA, not generic terms)
2. Analyze the FULL warning letter content, especially violations
3. Pay special attention to deadlines and required actions
4. Assess severity based on number and nature of violations
5. Consider the response requirements and timeline

Return a JSON object with ALL these fields (all required):
{
  "canonical_company_name": "The actual company name from the letter",
  "summary": "Comprehensive 4-5 sentence summary including key violations, required actions, and deadlines",
  "regulatory_impact": "Specific regulatory implications based on the violations cited",
  "business_impact": "Business, market, and operational implications",
  "action_required": "Specific actions the company must take based on the warning letter",
  "timeline": "Response timeline and all deadlines mentioned",
  "severity_assessment": 8, // 1-10 scale based on violations (warning letters typically 7-9)
  "key_violations": ["violation 1", "violation 2"], // Array of most critical violations
  "response_strategy": "Recommended approach for responding to FDA",
  "compliance_recommendations": "Specific improvements needed to address violations",
  "public_context": "Any relevant context about this company's regulatory history",
  "precedent_refs": ["similar case 1", "similar case 2"] // Array of similar FDA cases
}`
            },
            {
              role: "user",
              content: `Analyze this FDA warning letter comprehensively. Extract ALL critical information and provide detailed analysis.

${contentToAnalyze}

Remember to return ONLY valid JSON with all required fields.`
            }
          ],
          temperature: 0.2,
          max_tokens: 3000, // Increased for comprehensive analysis
          response_format: { type: "json_object" }
        });
        
        const aiResponse = completion.choices[0].message.content;
        console.log('✅ OpenAI responded with analysis');
        
        try {
          const parsedResponse = JSON.parse(aiResponse);
          aiResult = { ...aiResult, ...parsedResponse };
          
          // Override with warning letter company if AI got it wrong
          if (warningLetterData?.company && 
              (aiResult.canonical_company_name === 'Unknown Company' || 
               aiResult.canonical_company_name === 'FDA')) {
            aiResult.canonical_company_name = warningLetterData.company;
          }
          
          // Ensure we have reasonable defaults for warning letters
          if (types?.includes('warning_letter') && aiResult.severity_assessment < 7) {
            aiResult.severity_assessment = 7; // Minimum severity for warning letters
          }
          
          console.log('📊 AI Analysis Complete:');
          console.log('  - Company:', aiResult.canonical_company_name);
          console.log('  - Severity:', aiResult.severity_assessment);
          console.log('  - Key violations:', aiResult.key_violations?.length || 0);
          
        } catch (parseError) {
          console.error('Failed to parse AI response:', parseError);
          aiResult.summary = aiResponse;
        }
        
      } catch (aiError) {
        console.error('OpenAI error:', aiError.message);
        
        // Fallback analysis using warning letter data
        if (warningLetterData) {
          aiResult = createFallbackAnalysis(warningLetterData, aiResult);
        }
      }
    } else {
      console.log('⚠️ OpenAI not configured, using fallback analysis');
      
      // Create detailed fallback analysis from warning letter data
      if (warningLetterData) {
        aiResult = createFallbackAnalysis(warningLetterData, aiResult);
      }
    }
    
    // Now search for contacts if we have a company name
    let contactsData = null;
    if (aiResult.canonical_company_name && aiResult.canonical_company_name !== 'Unknown Company') {
      console.log(`\n📧 Searching contacts for: ${aiResult.canonical_company_name}`);
      
      // Find domain for the company
      const domain = await companyIntel.findCompanyDomain(aiResult.canonical_company_name);
      console.log(`🌐 Domain: ${domain}`);
      
      // Search for contacts
      contactsData = await companyIntel.findContactsForCompany(aiResult.canonical_company_name, domain);
      
      if (contactsData) {
        // Collect all emails
        const allEmails = [];
        
        // Add warning letter recipient email if available
        if (warningLetterData?.recipient?.email) {
          allEmails.push(warningLetterData.recipient.email);
        }
        
        // Add emails from contact search
        if (contactsData.emails && contactsData.emails.length > 0) {
          contactsData.emails.forEach(e => {
            if (e.email) allEmails.push(e.email);
          });
        }
        
        // Add regulatory contacts
        if (contactsData.regulatory_contacts) {
          contactsData.regulatory_contacts.forEach(c => {
            if (c.email) allEmails.push(c.email);
          });
        }
        
        // Add executives
        if (contactsData.executives) {
          contactsData.executives.forEach(e => {
            if (e.email) allEmails.push(e.email);
          });
        }
        
        // Add general email
        if (contactsData.general_email) {
          allEmails.push(contactsData.general_email);
        }
        
        // Remove duplicates
        aiResult.emails = [...new Set(allEmails)];
        aiResult.contacts = contactsData;
        
        console.log(`✅ Found ${aiResult.emails.length} unique emails`);
      }
    }
    
    // Cache the result if we have meaningful data
    if (aiResult.canonical_company_name !== 'Unknown Company') {
      const cacheKey = `${title}_${link}`.substring(0, 100);
      companyIntel.aiCache.set(cacheKey, aiResult);
      
      // Update company record
      if (itemId) {
        const allData = await fs.readFile(DATA_FILES.ALL_ITEMS, 'utf8');
        const items = JSON.parse(allData);
        const item = items.find(i => i.id === itemId);
        if (item) {
          item.ai_enhanced = true;
          item.canonical_company = aiResult.canonical_company_name;
          item.severity = aiResult.severity_assessment || item.severity;
          await fs.writeFile(DATA_FILES.ALL_ITEMS, JSON.stringify(items, null, 2));
        }
      }
    }
    
    console.log('\n✅ Enhancement complete\n');
    
    res.json({
      success: true,
      ...aiResult,
      debug: {
        hadOpenAI: !!openai,
        hadHunter: !!API_KEYS.HUNTER,
        hadApollo: !!API_KEYS.APOLLO,
        hadWarningLetter: !!warningLetterData,
        warningLetterContentLength: warningLetterData?.letterContent?.length || 0,
        foundCompany: aiResult.canonical_company_name !== 'Unknown Company',
        emailCount: aiResult.emails.length
      }
    });
    
  } catch (error) {
    console.error('AI enhance error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      canonical_company_name: 'Unknown Company',
      summary: 'Enhancement failed',
      emails: []
    });
  }
});

// Helper function for fallback analysis
function createFallbackAnalysis(warningLetterData, baseResult) {
  const result = { ...baseResult };
  
  result.canonical_company_name = 
    warningLetterData.company || 
    warningLetterData.companyName || 
    warningLetterData.recipient?.company || 
    'Unknown Company';
  
  // Build summary
  let summary = `FDA Warning Letter issued to ${result.canonical_company_name}`;
  if (warningLetterData.letterDate) {
    summary += ` on ${warningLetterData.letterDate}`;
  }
  if (warningLetterData.violations?.length > 0) {
    summary += `. ${warningLetterData.violations.length} violations cited including regulatory compliance issues`;
  }
  if (warningLetterData.responseDeadline) {
    summary += `. Response required within ${warningLetterData.responseDeadline}`;
  }
  if (warningLetterData.products?.length > 0) {
    summary += `. Affects ${warningLetterData.products.length} products`;
  }
  result.summary = summary + '.';
  
  // Set fields based on warning letter data
  result.key_violations = warningLetterData.violations?.slice(0, 10) || [];
  result.severity_assessment = warningLetterData.violations?.length > 5 ? 8 : 7;
  result.timeline = warningLetterData.responseDeadline || 'Standard 15 working days';
  result.action_required = 'Company must respond to all violations cited and provide corrective action plan';
  result.regulatory_impact = 'Potential enforcement action if not addressed. May affect product approvals';
  result.business_impact = 'Reputation risk, potential stock impact, possible manufacturing delays';
  
  return result;
}
// Send daily digest
async function sendDailyDigest(user, items) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a202c; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
        .content { background: white; padding: 20px; border: 1px solid #e2e8f0; border-radius: 0 0 10px 10px; }
        .item { padding: 15px; margin: 10px 0; background: #f7fafc; border-radius: 5px; }
        .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #718096; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin: 0;">Daily FDA Update</h2>
          <p style="margin: 5px 0 0 0; opacity: 0.9;">${new Date().toLocaleDateString()}</p>
        </div>
        <div class="content">
          <p><strong>${items.length} new regulatory actions in the last 24 hours:</strong></p>
          ${items.slice(0, 10).map(item => `
            <div class="item">
              <strong>${item.company}</strong> - ${item.types[0].replace(/_/g, ' ').toUpperCase()}<br>
              <small>${item.title}</small><br>
              <a href="${item.link}" style="color: #4299e1;">View Details →</a>
            </div>
          `).join('')}
          ${items.length > 10 ? `<p style="text-align: center; color: #718096;">... and ${items.length - 10} more</p>` : ''}
        </div>
        <div class="footer">
          <p>FDA Regulatory Intelligence System - Daily Digest</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const emails = [user.email, ...user.reportEmails];
  
  for (const email of emails) {
    try {
      await emailTransporter.sendMail({
        from: API_KEYS.SMTP_USER,
        to: email,
        subject: `FDA Daily Update: ${items.length} New Actions`,
        html: html
      });
      console.log(`✅ Daily digest sent to ${email}`);
    } catch (error) {
      console.error(`❌ Failed to send daily digest to ${email}:`, error.message);
    }
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 
      'Internal server error' : err.message
  });
});

// Start server
async function start() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🏥 FDA REGULATORY INTELLIGENCE SYSTEM v5.0');
    console.log('='.repeat(80));
    
    // Initialize systems
    console.log('\n📦 Initializing systems...');
    
    await initStorage();
    await connectDB();
    await companyIntel.initialize();
    
    // Setup scheduled tasks
    setupScheduledTasks();
    
    const PORT = process.env.PORT || 3000;
    
    app.listen(PORT, () => {
      console.log('\n✅ Server Configuration:');
      console.log(`   Port: ${PORT}`);
      console.log(`   Dashboard: http://localhost:${PORT}`);
      console.log(`   API Base: http://localhost:${PORT}/api`);
      console.log(`   Health Check: http://localhost:${PORT}/health`);
      
      console.log('\n🔑 Service Status:');
      console.log(`   MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Not connected'}`);
      console.log(`   Email: ${emailTransporter ? '✅ Configured' : '❌ Not configured'}`);
      console.log(`   OpenAI: ${openai ? '✅ Configured' : '❌ Not configured'}`);
      console.log(`   Hunter.io: ${API_KEYS.HUNTER ? '✅ Configured' : '❌ Not configured'}`);
      console.log(`   Apollo.io: ${API_KEYS.APOLLO ? '✅ Configured' : '❌ Not configured'}`);
      
      console.log('\n📊 Features:');
      console.log('   • Real-time FDA monitoring (30-day window)');
      console.log('   • Advanced company matching & intelligence');
      console.log('   • AI-enhanced analysis (when configured)');
      console.log('   • Contact discovery (Hunter/Apollo)');
      console.log('   • Instant & scheduled notifications');
      console.log('   • Company risk scoring');
      console.log('   • Compliance tracking');
      console.log('   • Audit logging');
      console.log('   • Automated backups');
      
      console.log('\n⏰ Scheduled Tasks:');
      console.log('   • Data refresh: Every 30 minutes');
      console.log('   • Weekly digests: Hourly check');
      console.log('   • Daily digests: Hourly check');
      console.log('   • Backups: Daily at 2 AM');
      
      console.log('\n🔄 Running initial data aggregation...\n');
    });
    
    // Initial data fetch
    const stats = await aggregateAllSources();
    
    console.log('\n' + '='.repeat(80));
    console.log('✨ SYSTEM READY - All services operational');
    console.log('='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
  console.log('\n📛 SIGTERM received, shutting down gracefully...');

  try {
    if (emailTransporter) {
      emailTransporter.close();
      console.log('📨 Email transporter closed');
    }

    await mongoose.connection.close();
    console.log('🛑 MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error during SIGTERM shutdown:', err.message);
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n📛 SIGINT (Ctrl+C) received, shutting down gracefully...');

  try {
    if (emailTransporter) {
      emailTransporter.close();
      console.log('📨 Email transporter closed');
    }

    await mongoose.connection.close();
    console.log('🛑 MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error during SIGINT shutdown:', err.message);
  }

  process.exit(0);
});

// Run if main module
if (require.main === module) {
  start();
}
