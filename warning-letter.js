// server.js - Simple FDA Warning Letters Monitor
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const parser = new Parser();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Data storage
const DATA_FILE = './warning_letters.json';

// Initialize storage
async function initStorage() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]');
    console.log('Created data file');
  }
}

// Main function - just get warning letters
async function getWarningLetters() {
  const letters = [];
  
  try {
    // 1. Check RSS Feed (most reliable)
    console.log('Checking FDA Warning Letters RSS...');
    const feed = await parser.parseURL('https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/warning-letters/rss.xml');
    
    feed.items.forEach(item => {
      const date = new Date(item.pubDate || item.isoDate);
      letters.push({
        id: `RSS-${Date.now()}-${letters.length}`,
        title: item.title,
        link: item.link,
        date: date.toISOString(),
        dateFormatted: date.toLocaleDateString(),
        source: 'RSS Feed',
        summary: item.contentSnippet || item.content || '',
        company: extractCompanyName(item.title)
      });
    });
    
    console.log(`Found ${feed.items.length} letters from RSS`);
    
  } catch (error) {
    console.error('RSS Error:', error.message);
  }
  
  try {
    // 2. Scrape main warning letters page
    console.log('Scraping FDA Warning Letters page...');
    const response = await axios.get('https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    const $ = cheerio.load(response.data);
    
    // Try different selectors that FDA might use
    const selectors = [
      'table tbody tr',
      '.warning-letter-list tr',
      '.views-table tbody tr',
      'article',
      '.node--type-warning-letter'
    ];
    
    let foundRows = false;
    for (const selector of selectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        foundRows = true;
        console.log(`Found ${elements.length} elements with selector: ${selector}`);
        
        elements.each((i, elem) => {
          const $row = $(elem);
          
          // Try to extract link and title
          const link = $row.find('a').first();
          const href = link.attr('href');
          const title = link.text() || $row.find('td').first().text();
          
          // Try to find date
          const dateText = $row.find('td').last().text() || 
                          $row.find('.date').text() || 
                          $row.find('time').text();
          
          if (href && title) {
            const fullUrl = href.startsWith('http') ? href : `https://www.fda.gov${href}`;
            
            letters.push({
              id: `WEB-${Date.now()}-${letters.length}`,
              title: title.trim(),
              link: fullUrl,
              date: parseDate(dateText),
              dateFormatted: parseDate(dateText, true),
              source: 'FDA Website',
              summary: '',
              company: extractCompanyName(title)
            });
          }
        });
        
        if (letters.length > 0) break;
      }
    }
    
    if (!foundRows) {
      console.log('No table rows found - page structure may have changed');
    }
    
  } catch (error) {
    console.error('Scraping Error:', error.message);
  }
  
  // Remove duplicates based on link
  const uniqueLetters = [];
  const seenLinks = new Set();
  
  letters.forEach(letter => {
    if (!seenLinks.has(letter.link)) {
      seenLinks.add(letter.link);
      uniqueLetters.push(letter);
    }
  });
  
  // Sort by date (newest first)
  uniqueLetters.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  return uniqueLetters;
}

function extractCompanyName(title) {
  // Try to extract company name from title
  const patterns = [
    /to\s+([^-–]+?)(?:\s+-|$)/i,
    /:\s+([^-–]+?)(?:\s+-|$)/i,
    /regarding\s+([^-–]+?)(?:\s+-|$)/i,
    /-\s+([^-–]+?)$/i
  ];
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return title.split('-')[0].trim();
}

function parseDate(dateText, formatted = false) {
  if (!dateText) return formatted ? 'Unknown' : new Date().toISOString();
  
  const cleaned = dateText.trim();
  const date = new Date(cleaned);
  
  if (isNaN(date)) {
    return formatted ? 'Unknown' : new Date().toISOString();
  }
  
  return formatted ? date.toLocaleDateString() : date.toISOString();
}

// API Routes
app.get('/api/letters', async (req, res) => {
  try {
    const letters = await getWarningLetters();
    
    // Filter by timeframe if requested
    const days = parseInt(req.query.days) || 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const filtered = letters.filter(letter => 
      new Date(letter.date) >= cutoffDate
    );
    
    res.json({
      success: true,
      total: filtered.length,
      timeframe: `${days} days`,
      letters: filtered
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const letters = await getWarningLetters();
    await fs.writeFile(DATA_FILE, JSON.stringify(letters, null, 2));
    
    res.json({
      success: true,
      message: `Found ${letters.length} warning letters`,
      count: letters.length
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const letters = await getWarningLetters();
    
    const now = new Date();
    const stats = {
      total: letters.length,
      last24h: letters.filter(l => (now - new Date(l.date)) < 86400000).length,
      last7days: letters.filter(l => (now - new Date(l.date)) < 604800000).length,
      last30days: letters.filter(l => (now - new Date(l.date)) < 2592000000).length
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
async function start() {
  await initStorage();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ FDA Warning Letters Monitor running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔄 Checking for letters...`);
  });
  
  // Get initial data
  getWarningLetters().then(letters => {
    console.log(`\n📧 Found ${letters.length} warning letters`);
  });
}

start();