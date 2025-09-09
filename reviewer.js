// server.js - CGMP Contact Profiler Backend with PubMed Integration
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios'); // Add axios for PubMed API calls
require('dotenv').config();
// after other imports
const externalIntel = require('./external-intel.js');
const contactsProfile = require('./contacts-profile-route.js');
const app = express();
// mount routers
app.use(externalIntel.router);
// app.use(contactsProfile.router);



// ...after app & middleware
// app.use(externalIntelRouter);
// Middleware
app.use(cors({
//   origin: process.env.NODE_ENV === 'production' 
//     ? process.env.FRONTEND_URL 
//     : 'http://localhost:3001'
}));
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection with Atlas support
const connectDB = async () => {
  const maxRetries = 5;
  let retries = 0;
  
  // Check if using Atlas (srv connection string)
  const isAtlas =  'mongodb+srv://syneticslz:gMN1GUBtevSaw8DE@synetictest.bl3xxux.mongodb.net/?retryWrites=true&w=majority&appName=SyneticTest'.includes('mongodb+srv://');
  
  while (retries < maxRetries) {
    try {
      const connectionOptions = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      };
      
      // Add database name if not in connection string
      let mongoUri = 'mongodb+srv://syneticslz:gMN1GUBtevSaw8DE@synetictest.bl3xxux.mongodb.net/fda_database?retryWrites=true&w=majority&appName=SyneticTest' ;
      // For Atlas, ensure database name is included
      if (isAtlas && !mongoUri.includes('?')) {
        mongoUri += '?retryWrites=true&w=majority';
      }
      
      console.log('🔄 Connecting to MongoDB Atlas...');
      await mongoose.connect(mongoUri, connectionOptions);
      
      console.log('✅ MongoDB Atlas connected successfully');
      
      // Test the connection by listing collections
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log(`📊 Found ${collections.length} collections in database`);
      
      // Check if cgmp_guidance collection exists
      const cgmpExists = collections.some(c => c.name === 'cgmp_guidance');
      if (cgmpExists) {
        const count = await mongoose.connection.db.collection('cgmp_guidance').countDocuments();
        console.log(`📋 CGMP Guidance collection has ${count} documents`);
      } else {
        console.log('⚠️  CGMP Guidance collection not found - it will be created when needed');
      }
      
      return;
    } catch (err) {
      retries++;
      console.error(`❌ MongoDB connection attempt ${retries} failed:`, err.message);
      
      if (err.message.includes('bad auth')) {
        console.error('\n⚠️  Authentication failed. Please check:');
        console.error('  1. Username and password in connection string');
        console.error('  2. Database user has correct permissions');
        console.error('  3. Connection string format is correct\n');
        process.exit(1);
      }
      
      if (err.message.includes('ECONNREFUSED')) {
        console.error('\n⚠️  Connection refused. Please check:');
        console.error('  1. IP address is whitelisted in Atlas (Network Access)');
        console.error('  2. Cluster is active and running');
        console.error('  3. Connection string is correct\n');
      }
      
      if (retries === maxRetries) {
        console.error('\n❌ Failed to connect to MongoDB Atlas after', maxRetries, 'attempts');
        console.error('Connection string:', process.env.MONGODB_URI?.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
        process.exit(1);
      }
      
      console.log(`Retrying in 5 seconds... (${retries}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

// Connect to MongoDB
connectDB();

// OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Schema
const documentSchema = new mongoose.Schema({
  id: String,
  filename: String,
  question: String,
  answer: String,
  text_snippet: String,
  summary: String,
  category: String,
  keywords: [String],
  drug_mentions: [String],
  regulations: [String],
  contacts: [{
    name: String,
    email: String,
    phone: String
  }],
  risk_level: String,
  uploadedAt: Date,
  uploadBatch: String,
  dataSource: String
}, { collection: 'cgmp_guidance' });

const Document = mongoose.model('Document', documentSchema);

// Helper Functions
function encodeContactId(name, email) {
  return Buffer.from(`${name}|${email}`).toString('base64');
}

function decodeContactId(contactId) {
  const decoded = Buffer.from(contactId, 'base64').toString('utf-8');
  const [name, email] = decoded.split('|');
  return { name, email };
}

function normalizeContact(contact) {
  return {
    name: contact.name?.trim() || 'Unknown',
    email: contact.email?.toLowerCase().trim() || '',
    phone: contact.phone?.trim() || ''
  };
}

// Extract contacts from text if no structured contacts
function extractContactsFromText(text) {
  const contacts = [];
  if (!text) return contacts;
  
  // Email pattern
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emails = text.match(emailRegex) || [];
  
  // FDA contact pattern (Name at email)
  const contactPattern = /([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:at|@)\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let match;
  while ((match = contactPattern.exec(text)) !== null) {
    contacts.push({
      name: match[1],
      email: match[2]
    });
  }
  
  // Fallback: emails without names
  emails.forEach(email => {
    if (!contacts.some(c => c.email === email)) {
      const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
      contacts.push({
        name: namePart.split(' ').map(w => 
          w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        ).join(' '),
        email: email
      });
    }
  });
  
  return contacts;
}

// PubMed Search Function
async function searchPubMed(authorName, maxResults = 10) {
  try {
    // Clean and format the author name for PubMed search
    const cleanName = authorName.trim();
    
    // First, search for articles by this author
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;
    const searchParams = {
      db: 'pubmed',
      term: `${cleanName}[Author]`,
      retmode: 'json',
      retmax: maxResults,
      sort: 'relevance',
      usehistory: 'y'
    };
    
    console.log(`🔍 Searching PubMed for author: ${cleanName}`);
    
    const searchResponse = await axios.get(searchUrl, { params: searchParams });
    const searchData = searchResponse.data;
    
    if (!searchData.esearchresult || !searchData.esearchresult.idlist || searchData.esearchresult.idlist.length === 0) {
      console.log(`No PubMed articles found for ${cleanName}`);
      return [];
    }
    
    // Get details for the found articles
    const ids = searchData.esearchresult.idlist.join(',');
    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const fetchParams = {
      db: 'pubmed',
      id: ids,
      retmode: 'xml',
      rettype: 'abstract'
    };
    
    const fetchResponse = await axios.get(fetchUrl, { params: fetchParams });
    const xmlData = fetchResponse.data;
    
    // Parse XML to extract article information
    const articles = parseXMLArticles(xmlData, cleanName);
    
    console.log(`✅ Found ${articles.length} PubMed articles for ${cleanName}`);
    return articles;
    
  } catch (error) {
    console.error('Error searching PubMed:', error.message);
    return [];
  }
}

// Parse PubMed XML Response
function parseXMLArticles(xmlString, searchAuthor) {
  const articles = [];
  
  // Basic XML parsing using regex (in production, consider using xml2js package)
  const articleMatches = xmlString.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g) || [];
  
  for (const articleXml of articleMatches) {
    try {
      // Extract PMID
      const pmidMatch = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      const pmid = pmidMatch ? pmidMatch[1] : '';
      
      // Extract title
      const titleMatch = articleXml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      
      // Extract authors
      const authorMatches = articleXml.match(/<Author[^>]*>([\s\S]*?)<\/Author>/g) || [];
      const authors = [];
      let isFirstAuthor = false;
      let authorPosition = 0;
      
      for (const authorXml of authorMatches) {
        authorPosition++;
        const lastNameMatch = authorXml.match(/<LastName>([\s\S]*?)<\/LastName>/);
        const foreNameMatch = authorXml.match(/<ForeName>([\s\S]*?)<\/ForeName>/);
        
        if (lastNameMatch) {
          const lastName = lastNameMatch[1];
          const foreName = foreNameMatch ? foreNameMatch[1] : '';
          const fullName = `${foreName} ${lastName}`.trim();
          authors.push(fullName);
          
          // Check if this is our search author
          if (fullName.toLowerCase().includes(searchAuthor.toLowerCase()) || 
              searchAuthor.toLowerCase().includes(fullName.toLowerCase())) {
            if (authorPosition === 1) isFirstAuthor = true;
          }
        }
      }
      
      // Extract journal
      const journalMatch = articleXml.match(/<Title>([\s\S]*?)<\/Title>/);
      const journal = journalMatch ? journalMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      
      // Extract year
      const yearMatch = articleXml.match(/<Year>(\d{4})<\/Year>/);
      const year = yearMatch ? yearMatch[1] : '';
      
      // Extract abstract
      const abstractMatch = articleXml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      const abstract = abstractMatch ? abstractMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 500) + '...' : '';
      
      // Extract DOI if available
      const doiMatch = articleXml.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/);
      const doi = doiMatch ? doiMatch[1] : '';
      
      articles.push({
        pmid,
        title,
        authors: authors.slice(0, 5), // Limit to first 5 authors
        authorCount: authors.length,
        isFirstAuthor,
        journal,
        year,
        abstract: abstract.substring(0, 300) + (abstract.length > 300 ? '...' : ''),
        doi,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      });
      
    } catch (err) {
      console.error('Error parsing article:', err.message);
    }
  }
  
  return articles;
}

// Routes

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    services: {
      mongodb: mongoose.connection.readyState === 1,
      openai: !!process.env.OPENAI_API_KEY,
      pubmed: true
    },
    timestamp: new Date().toISOString()
  });
});

// GET /contacts - Aggregate and list all contacts
app.get('/contacts', async (req, res) => {
  try {
    const { search = '', page = 1, pageSize = 20 } = req.query;
    const pageNum = parseInt(page);
    const size = parseInt(pageSize);
    const skip = (pageNum - 1) * size;
    
    console.log(`Fetching contacts: search="${search}", page=${pageNum}, size=${size}`);
    
    // Build aggregation pipeline
    const pipeline = [
      // Unwind contacts array
      {
        $unwind: {
          path: '$contacts',
          preserveNullAndEmptyArrays: false
        }
      },
      // Normalize contact fields
      {
        $project: {
          contact: {
            name: { $trim: { input: '$contacts.name' } },
            email: { $toLower: { $trim: { input: '$contacts.email' } } },
            phone: { $ifNull: ['$contacts.phone', ''] }
          },
          title: { $concat: ['$category', ': ', '$question'] },
          docId: '$_id',
          uploadedAt: 1
        }
      },
      // Filter out invalid contacts
      {
        $match: {
          'contact.name': { $exists: true, $ne: '', $ne: null },
          'contact.email': { $exists: true, $ne: '', $ne: null }
        }
      }
    ];
    
    // Add search filter if provided
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { 'contact.name': { $regex: search, $options: 'i' } },
            { 'contact.email': { $regex: search, $options: 'i' } }
          ]
        }
      });
    }
    
    // Group by contact
    pipeline.push(
      {
        $group: {
          _id: {
            name: '$contact.name',
            email: '$contact.email'
          },
          phone: { $first: '$contact.phone' },
          docCount: { $sum: 1 },
          recentDocs: {
            $push: {
              title: '$title',
              docId: '$docId',
              uploadedAt: '$uploadedAt'
            }
          }
        }
      },
      // Sort by document count and name
      {
        $sort: { docCount: -1, '_id.name': 1 }
      },
      // Format output
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          email: '$_id.email',
          phone: 1,
          docCount: 1,
          recentTitles: {
            $map: {
              input: { $slice: ['$recentDocs', 5] },
              as: 'doc',
              in: { $ifNull: ['$$doc.title', ''] }
            }
          }
        }
      }
    );
    
    // Execute aggregation for data
    const contacts = await Document.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: size }
    ]);
    
    // Get total count
    const totalPipeline = pipeline.slice(0, -1); // Remove project stage
    const countResult = await Document.aggregate([
      ...totalPipeline.slice(0, -1), // Remove sort
      { $count: 'total' }
    ]);
    
    const total = countResult[0]?.total || 0;
    
    // Add contactId to each contact using JavaScript
    const formattedContacts = contacts.map(c => ({
      ...c,
      contactId: encodeContactId(c.name, c.email)
    }));
    
    res.json({
      success: true,
      contacts: formattedContacts,
      pagination: {
        page: pageNum,
        pageSize: size,
        total,
        totalPages: Math.ceil(total / size)
      }
    });
    
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /contacts/:contactId/docs - Get documents for a specific contact
app.get('/contacts/:contactId/docs', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { onlyCGMP = 'true' } = req.query;
    
    const { name, email } = decodeContactId(contactId);
    
    console.log(`Fetching docs for: ${name} (${email})`);
    
    // Build query
    const query = {
      'contacts.name': name,
      'contacts.email': email
    };
    
    if (onlyCGMP === 'true') {
      query.$or = [
        { dataSource: /CGMP/i },
        { category: /CGMP/i },
        { keywords: { $in: [/CGMP/i, /GMP/i] } }
      ];
    }
    
    const documents = await Document.find(query)
      .select('filename question category summary risk_level uploadedAt keywords regulations')
      .sort({ uploadedAt: -1 })
      .limit(100);
    
    const formattedDocs = documents.map(doc => ({
      _id: doc._id,
      title: `${doc.category}: ${doc.question}`,
      filename: doc.filename,
      summary: doc.summary,
      risk_level: doc.risk_level,
      uploadedAt: doc.uploadedAt,
      tags: [
        doc.risk_level,
        ...doc.keywords.slice(0, 3),
        ...doc.regulations.slice(0, 2)
      ].filter(Boolean)
    }));
    
    res.json({
      success: true,
      contact: { name, email },
      documents: formattedDocs,
      total: formattedDocs.length
    });
    
  } catch (error) {
    console.error('Error fetching contact documents:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /contacts/:contactId/publications - Get PubMed publications
app.get('/contacts/:contactId/publications', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { maxResults = 10 } = req.query;
    
    const { name, email } = decodeContactId(contactId);
    
    console.log(`Fetching PubMed publications for: ${name}`);
    
    // Search PubMed for this author
    const publications = await searchPubMed(name, parseInt(maxResults));
    
    res.json({
      success: true,
      contact: { name, email },
      publications,
      total: publications.length
    });
    
  } catch (error) {
    console.error('Error fetching publications:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /contacts/:contactId/profile - Generate AI profile with publications
app.post('/contacts/:contactId/profile', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { maxDocs = 10, includePubMed = true } = req.body;
    
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OpenAI API key not configured'
      });
    }
    
    const { name, email } = decodeContactId(contactId);
    
    console.log(`Generating AI profile for: ${name} (${email})`);
    
    // Get CGMP documents for this contact
    const documents = await Document.find({
      'contacts.name': name,
      'contacts.email': email,
      $or: [
        { dataSource: /CGMP/i },
        { category: /CGMP/i },
        { keywords: { $in: [/CGMP/i, /GMP/i] } }
      ]
    })
    .select('question answer summary category keywords regulations risk_level')
    .sort({ uploadedAt: -1 })
    .limit(parseInt(maxDocs));
    
    // Get PubMed publications if requested
    let publications = [];
    if (includePubMed) {
      publications = await searchPubMed(name, 5);
    }
    
    if (documents.length === 0 && publications.length === 0) {
      return res.json({
        success: true,
        profile: {
          name,
          email,
          areas_of_expertise: [],
          themes: [],
          influence_score: 0,
          notable_docs: [],
          publications: [],
          summary: 'No CGMP documents or publications found for this contact.'
        }
      });
    }
    
    // Prepare document snippets for AI
    const docSnippets = documents.map(doc => ({
      title: `${doc.category}: ${doc.question}`,
      excerpt: (doc.answer || doc.summary || '').substring(0, 1200),
      risk: doc.risk_level,
      keywords: doc.keywords.slice(0, 5),
      regulations: doc.regulations
    }));
    
    // Create AI prompt
    const systemPrompt = `You are an analyst building a concise professional profile from CGMP documents and academic publications. 
    Analyze the provided documents and return a JSON object with these exact keys:
    - name: string
    - email: string  
    - areas_of_expertise: array of strings (3-5 areas based on both CGMP docs and publications)
    - themes: array of strings (common topics they address)
    - influence_score: number 0-100 (based on document count, complexity, risk levels, and publication impact)
    - notable_docs: array of 2-3 most significant document titles
    - research_focus: string (brief description of their research interests based on publications)
    - summary: string (2-3 sentences about their expertise, contributions, and academic work)
    
    Return ONLY valid JSON, no additional text.`;
    
    const userPrompt = `Contact: ${name} (${email})
    Total CGMP Documents: ${documents.length}
    Total Publications: ${publications.length}
    
    Document Excerpts:
    ${docSnippets.map((doc, i) => `
    ${i + 1}. TITLE: ${doc.title}
    RISK: ${doc.risk}
    KEYWORDS: ${doc.keywords.join(', ')}
    REGULATIONS: ${doc.regulations.join(', ')}
    EXCERPT: ${doc.excerpt}
    `).join('\n')}
    
    Academic Publications:
    ${publications.map((pub, i) => `
    ${i + 1}. TITLE: ${pub.title}
    JOURNAL: ${pub.journal} (${pub.year})
    AUTHORS: ${pub.authors.join(', ')}${pub.authorCount > 5 ? ` and ${pub.authorCount - 5} others` : ''}
    ${pub.isFirstAuthor ? '[FIRST AUTHOR]' : '[CO-AUTHOR]'}
    `).join('\n')}
    
    Generate the professional profile JSON.`;
    
    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 1000,
      response_format: { type: 'json_object' }
    });
    
    let profile;
    try {
      profile = JSON.parse(completion.choices[0].message.content);
    } catch (parseError) {
      console.error('Failed to parse AI response:', completion.choices[0].message.content);
      profile = {
        name,
        email,
        areas_of_expertise: ['CGMP Compliance'],
        themes: ['Quality Assurance'],
        influence_score: 50,
        notable_docs: docSnippets.slice(0, 2).map(d => d.title),
        research_focus: publications.length > 0 ? 'Pharmaceutical Research' : '',
        summary: `${name} has contributed to ${documents.length} CGMP guidance documents and ${publications.length} academic publications.`
      };
    }
    
    // Ensure all required fields
    profile = {
      name: profile.name || name,
      email: profile.email || email,
      areas_of_expertise: profile.areas_of_expertise || [],
      themes: profile.themes || [],
      influence_score: profile.influence_score || 0,
      notable_docs: profile.notable_docs || [],
      research_focus: profile.research_focus || '',
      summary: profile.summary || '',
      document_count: documents.length,
      publication_count: publications.length,
      publications: publications.slice(0, 5), // Include top 5 publications
      generated_at: new Date().toISOString()
    };
    
    res.json({
      success: true,
      profile
    });
    
  } catch (error) {
    console.error('Error generating profile:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /stats - Dashboard statistics
app.get('/stats', async (req, res) => {
  try {
    const [totalDocs, totalContacts, riskDistribution] = await Promise.all([
      Document.countDocuments(),
      Document.aggregate([
        { $unwind: '$contacts' },
        { $group: { _id: { name: '$contacts.name', email: '$contacts.email' } } },
        { $count: 'total' }
      ]),
      Document.aggregate([
        { $group: { _id: '$risk_level', count: { $sum: 1 } } }
      ])
    ]);
    
    res.json({
      success: true,
      stats: {
        totalDocuments: totalDocs,
        totalContacts: totalContacts[0]?.total || 0,
        riskDistribution: riskDistribution.reduce((acc, r) => {
          acc[r._id || 'Unknown'] = r.count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ========================================
  🥼 CGMP Contact Profiler Server
  ========================================
  Port: ${PORT}
  MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Not connected'}
  OpenAI: ${process.env.OPENAI_API_KEY ? '✅ Configured' : '⚠️ Not configured'}
  PubMed: ✅ Enabled
  Environment: ${process.env.NODE_ENV || 'development'}
  ========================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await mongoose.connection.close();
  process.exit(0);
});