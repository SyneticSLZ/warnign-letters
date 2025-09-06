# FDA Advanced Monitoring System v2.0

## 🚀 Complete Data Extraction & Monitoring Solution

### What This System Does:

1. **Multiple Data Sources**:
   - FDA Warning Letters website (with Puppeteer for dynamic content)
   - FDA Form 483 database
   - 4 FDA RSS feeds (Warning Letters, Press Releases, Recalls, Outbreaks)
   - OpenFDA API (Enforcement & Recall data)
   - FDA Import Alerts
   - News sources (FDA News, RAPS, FDANews)

2. **Complete Data Extraction**:
   - Company name, address, FEI numbers
   - Full violation text and observations
   - CFR citations with frequency analysis
   - Inspector names and patterns
   - Contact information (emails, phones, officials)
   - PDF document parsing
   - Full letter content

3. **Data Quality Scoring**:
   - Each record gets a 0-100% completeness score
   - Filter by data quality
   - See exactly what data is missing

4. **Advanced Dashboard**:
   - Full article viewing
   - Source visibility
   - Violation analysis
   - Company profiles
   - Inspector trends
   - Export capabilities

## Installation

### Prerequisites:
- Node.js 16+ 
- Chrome/Chromium (for Puppeteer)

### Setup:

1. **Clone or create project folder**:
```bash
mkdir fda-advanced-monitoring
cd fda-advanced-monitoring
```

2. **Create these files**:
- `package.json` (copy from above)
- `server.js` (from the "FDA Advanced Monitoring System" artifact)
- `public/index.html` (combine both dashboard HTML artifacts)
- `.env` (optional, for notifications)

3. **Install dependencies**:
```bash
npm install
```

Note: Puppeteer will download Chromium (~170MB) on first install.

4. **Run the system**:
```bash
npm start
```

5. **Open dashboard**:
```
http://localhost:3000
```

## How to Use

### First Time Setup:
1. Start the server with `npm start`
2. Open the dashboard at http://localhost:3000
3. Click "Scrape All Sources" button
4. Wait 1-2 minutes for initial data collection
5. Data will appear in the dashboard

### Daily Usage:
- System automatically scrapes every hour
- Click "Scrape All Sources" for manual update
- Use filters to find specific data
- Click "View Full Details" on any record

### Understanding Data Quality:
- **80-100% (Excellent)**: Full data with article content
- **60-79% (Good)**: Most fields populated
- **40-59% (Fair)**: Basic information available
- **0-39% (Poor)**: Minimal data extracted

## Features Explained

### 1. Complete Inspection View:
- Click any inspection to see EVERYTHING
- Full letter text
- All violations listed
- CFR citations
- Contact information
- Source links
- PDF downloads

### 2. Data Sources:
Each record shows where it came from:
- `fda_website`: Direct scrape from FDA.gov
- `rss_feed`: FDA RSS feeds
- `fda_api`: OpenFDA API
- `news`: News sources

### 3. Violations Analysis Tab:
- Top CFR citations across all inspections
- Violation trends
- Recent observations
- Citation frequency charts

### 4. Companies Tab:
- All companies with inspections
- Total violations per company
- Inspection history
- Click to see all inspections for that company

### 5. Raw Data Tab:
- Full JSON export
- See exactly what was extracted
- Download complete dataset

## Troubleshooting

**"Puppeteer error" or browser issues**:
```bash
# Install system dependencies (Ubuntu/Debian)
sudo apt-get install -y chromium-browser

# Or on Mac
brew install chromium
```

**No data showing**:
1. Click "Scrape All Sources"
2. Check console for errors
3. Some FDA pages may be temporarily down

**Incomplete data**:
- Check the data quality score
- FDA pages vary in structure
- Click original source link to verify

**Memory issues**:
```bash
# Increase Node memory
node --max-old-space-size=4096 server.js
```

## Data Structure

Each inspection record contains:
```javascript
{
  id: "Unique identifier",
  type: "warning_letter|form_483|recall",
  source_url: "Original FDA URL",
  company: {
    name: "Company Name",
    address: "Full address",
    // ... complete company info
  },
  inspection: {
    date_issued: "ISO date",
    // ... inspection details
  },
  violations: {
    observations: [
      {
        number: "1",
        text: "Full violation text",
        cfr_references: ["21 CFR 211.22"]
      }
    ],
    cfr_citations: [
      {
        cfr: "21 CFR 211.22",
        description: "Context",
        count: 3
      }
    ]
  },
  content: {
    full_text: "Complete letter content",
    pdf_url: "Link to PDF"
  },
  contacts: {
    company_officials: [],
    fda_contacts: []
  },
  metadata: {
    data_quality_score: 85,
    extraction_method: "puppeteer"
  }
}
```

## API Endpoints

- `GET /api/inspections` - All inspections with filters
- `GET /api/inspection/:id` - Single inspection details  
- `GET /api/stats` - Dashboard statistics
- `POST /api/scrape` - Trigger manual scrape

### Query Parameters:
- `?type=warning_letter` - Filter by type
- `?company=Pfizer` - Search company name
- `?quality=60` - Minimum quality score
- `?page=1&limit=50` - Pagination

## Advanced Configuration

### Scraping Frequency:
Edit the cron schedule in server.js:
```javascript
// Every 30 minutes
cron.schedule('*/30 * * * *', scrapeAllSources);

// Every 2 hours
cron.schedule('0 */2 * * *', scrapeAllSources);
```

### Add Custom Data Sources:
Add to DATA_SOURCES in server.js:
```javascript
custom_source: {
  url: 'https://example.com/inspections',
  type: 'website',
  selector: '.inspection-item'
}
```

## Tips for Best Results

1. **Run first scrape during off-peak hours** (evening/night)
2. **Use quality filter** to see only complete records
3. **Export data regularly** for backup
4. **Check multiple sources** - RSS may have different data than website
5. **View original source** when data seems incomplete

## Support

- Data stored in: `./data/inspections.json`
- Logs in console show scraping progress
- Each source is tried independently (one failure won't stop others)

This system provides ORDER OF MAGNITUDE better data extraction than basic scrapers!