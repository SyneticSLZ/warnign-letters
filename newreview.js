// server.js — CGMP Contact Profiler (fully integrated with external-intel, PubMed, FDA reviewers)

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');

// ---------- external-intel (public data layer) ----------
const externalIntel = require('./external-intel'); // <- your module
const {
  router: externalRouter,
  ExternalArtifact,
  PersonIndex,
  runExternalDiscovery,
  buildExternalSummary,
  makeContactKey,
} = externalIntel;
const reviewers = require('./reviewers-route.js');


// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(reviewers.router);
// ---------- Mongo ----------
const MONGODB_URI =

  'mongodb+srv://syneticslz:gMN1GUBtevSaw8DE@synetictest.bl3xxux.mongodb.net/fda_database?retryWrites=true&w=majority&appName=SyneticTest' ;

mongoose.set('strictQuery', true);
mongoose
  .connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    console.log('✅ MongoDB connected');
    try {
      const colls = await mongoose.connection.db.listCollections().toArray();
      console.log(`📊 DB has ${colls.length} collections`);
    } catch (e) {}
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// ---------- CGMP Document model ----------
let Document;
try {
  // If you have a separate model file, prefer that
  Document = require('./models/Document').Document;
} catch {
  // Fallback to inline schema matching your earlier code
  const documentSchema = new mongoose.Schema(
    {
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
      contacts: [
        {
          name: String,
          email: String,
          phone: String,
        },
      ],
      risk_level: String,
      uploadedAt: Date,
      uploadBatch: String,
      dataSource: String,
    },
    { collection: 'cgmp_guidance' }
  );
  Document =
    mongoose.models.Document || mongoose.model('Document', documentSchema);
}

// ---------- OpenAI (optional; used by full AI profile) ----------
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ---------- Helpers ----------
function encodeContactId(name, email) {
  return Buffer.from(`${name}|${email}`).toString('base64');
}
function decodeContactId(contactId) {
  const [name, email] = Buffer.from(contactId, 'base64')
    .toString('utf-8')
    .split('|');
  return { name, email };
}
function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}
function safeStr(x) {
  return (x || '').toString();
}
function yearFromString(s) {
  if (!s) return undefined;
  const m = /(\d{4})/.exec(String(s));
  return m ? Number(m[1]) : undefined;
}

// ---------- PubMed: search + XML parse (kept from your previous code) ----------
async function searchPubMed(authorName, maxResults = 10) {
  try {
    const cleanName = authorName.trim();

    // ESearch
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;
    const searchParams = {
      db: 'pubmed',
      term: `${cleanName}[Author]`,
      retmode: 'json',
      retmax: maxResults,
      sort: 'relevance',
      usehistory: 'y',
    };
    const searchResponse = await axios.get(searchUrl, { params: searchParams, timeout: 20000 });
    const idlist = searchResponse.data?.esearchresult?.idlist || [];
    if (!idlist.length) return [];

    // EFetch (XML)
    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const fetchParams = {
      db: 'pubmed',
      id: idlist.join(','),
      retmode: 'xml',
      rettype: 'abstract',
    };
    const fetchResponse = await axios.get(fetchUrl, { params: fetchParams, timeout: 20000 });
    return parseXMLArticles(fetchResponse.data, cleanName);
  } catch (err) {
    console.error('PubMed error:', err.message);
    return [];
  }
}

function parseXMLArticles(xmlString, searchAuthor) {
  const articles = [];
  const matches = xmlString.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g) || [];
  for (const articleXml of matches) {
    try {
      const pmid = (articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1] || '';
      const rawTitle = (articleXml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/) || [])[1] || '';
      const title = rawTitle.replace(/<[^>]+>/g, '').trim();

      const authorMatches = articleXml.match(/<Author[^>]*>([\s\S]*?)<\/Author>/g) || [];
      const authors = [];
      let isFirstAuthor = false;
      let pos = 0;
      for (const aXml of authorMatches) {
        pos += 1;
        const lastName = (aXml.match(/<LastName>([\s\S]*?)<\/LastName>/) || [])[1];
        const foreName = (aXml.match(/<ForeName>([\s\S]*?)<\/ForeName>/) || [])[1];
        if (lastName) {
          const full = `${foreName || ''} ${lastName}`.trim();
          authors.push(full);
          const la = searchAuthor.toLowerCase();
          const fa = full.toLowerCase();
          if (fa.includes(la) || la.includes(fa)) {
            if (pos === 1) isFirstAuthor = true;
          }
        }
      }

      const journal = ((articleXml.match(/<Title>([\s\S]*?)<\/Title>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '')
        .trim();
      const year = (articleXml.match(/<Year>(\d{4})<\/Year>/) || [])[1] || '';
      const abstract = ((articleXml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .substring(0, 500);
      const doi = ((articleXml.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/) || [])[1] || '').trim();

      articles.push({
        pmid,
        title,
        authors: authors.slice(0, 5),
        authorCount: authors.length,
        isFirstAuthor,
        journal,
        year,
        abstract: abstract.length > 300 ? abstract.substring(0, 300) + '...' : abstract,
        doi,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    } catch (e) {
      // keep going
    }
  }
  return articles;
}

// ---------- Mount external-intel router (gives you /external/:contactId/search & /external/:contactId/artifacts) ----------
app.use(externalRouter);

// ======================================================================
// Core endpoints (kept & enhanced)
// ======================================================================

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1,
    openai: !!process.env.OPENAI_API_KEY,
    pubmed: true,
    timestamp: new Date().toISOString(),
  });
});

// GET /contacts (search + aggregate like your previous version)
app.get('/contacts', async (req, res) => {
  try {
    const { search = '', page = 1, pageSize = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10)));
    const skip = (pageNum - 1) * size;

    const pipeline = [
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          contact: {
            name: { $trim: { input: '$contacts.name' } },
            email: { $toLower: { $trim: { input: '$contacts.email' } } },
            phone: { $ifNull: ['$contacts.phone', ''] },
          },
          title: { $concat: ['$category', ': ', '$question'] },
          docId: '$_id',
          uploadedAt: 1,
        },
      },
      {
        $match: {
          'contact.name': { $exists: true, $ne: '', $ne: null },
          'contact.email': { $exists: true, $ne: '', $ne: null },
        },
      },
    ];

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { 'contact.name': { $regex: search, $options: 'i' } },
            { 'contact.email': { $regex: search, $options: 'i' } },
          ],
        },
      });
    }

    pipeline.push(
      {
        $group: {
          _id: { name: '$contact.name', email: '$contact.email' },
          phone: { $first: '$contact.phone' },
          docCount: { $sum: 1 },
          recentDocs: {
            $push: {
              title: '$title',
              docId: '$docId',
              uploadedAt: '$uploadedAt',
            },
          },
        },
      },
      { $sort: { docCount: -1, '_id.name': 1 } },
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
              in: { $ifNull: ['$$doc.title', ''] },
            },
          },
        },
      }
    );

    const contacts = await Document.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: size },
    ]);

    const totalPipeline = pipeline.slice(0, -1);
    const countResult = await Document.aggregate([
      ...totalPipeline.slice(0, -1),
      { $count: 'total' },
    ]);
    const total = countResult[0]?.total || 0;

    const formatted = contacts.map((c) => ({
      ...c,
      contactId: encodeContactId(c.name, c.email),
    }));

    res.json({
      success: true,
      contacts: formatted,
      pagination: {
        page: pageNum,
        pageSize: size,
        total,
        totalPages: Math.max(1, Math.ceil(total / size)),
      },
    });
  } catch (error) {
    console.error('GET /contacts error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /contacts/:contactId/docs
app.get('/contacts/:contactId/docs', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { onlyCGMP = 'true' } = req.query;
    const { name, email } = decodeContactId(contactId);

    const query = {
      'contacts.name': name,
      'contacts.email': email,
    };
    if (String(onlyCGMP) === 'true') {
      query.$or = [
        { dataSource: /CGMP/i },
        { category: /CGMP/i },
        { keywords: { $in: [/CGMP/i, /GMP/i] } },
      ];
    }

    const documents = await Document.find(query)
      .select(
        'filename question category summary risk_level uploadedAt keywords regulations'
      )
      .sort({ uploadedAt: -1 })
      .limit(100)
      .lean();

    const formatted = documents.map((doc) => ({
      _id: doc._id,
      title: `${doc.category}: ${doc.question}`,
      filename: doc.filename,
      summary: doc.summary,
      risk_level: doc.risk_level,
      uploadedAt: doc.uploadedAt,
      tags: [
        doc.risk_level,
        ...(doc.keywords || []).slice(0, 3),
        ...(doc.regulations || []).slice(0, 2),
      ].filter(Boolean),
    }));

    res.json({
      success: true,
      contact: { name, email },
      documents: formatted,
      total: formatted.length,
    });
  } catch (error) {
    console.error('GET /contacts/:id/docs error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /contacts/:contactId/publications (PubMed)
app.get('/contacts/:contactId/publications', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { maxResults = 10 } = req.query;
    const { name, email } = decodeContactId(contactId);
    const pubs = await searchPubMed(name, Math.max(1, parseInt(maxResults, 10)));
    res.json({
      success: true,
      contact: { name, email },
      publications: pubs,
      total: pubs.length,
    });
  } catch (error) {
    console.error('GET /contacts/:id/publications error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Utility: build unified "public works" from artifacts (+ PubMed), deduped
function buildPublicWorks(artifacts, pubmed) {
  const out = [];

  // External artifacts (multiple sources)
  for (const a of artifacts) {
    out.push({
      source: a.source,
      source_id: a.source_id,
      title: a.title || '',
      year: a.year || yearFromString(a?.fetchedAt),
      url: a.url || '',
      identifiers: a.identifiers || {},
      facets: a.facets || {},
      confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
    });
  }

  // PubMed items (normalize to same shape)
  for (const p of pubmed || []) {
    out.push({
      source: 'pubmed',
      source_id: p.pmid,
      title: p.title || '',
      year: yearFromString(p.year),
      url: p.pubmedUrl || '',
      identifiers: { pmid: p.pmid, doi: p.doi || undefined },
      facets: { journal: p.journal, authors: p.authors || [] },
      confidence: 0.8,
    });
  }

  // Deduplicate by DOI -> PMID -> (source|source_id) -> lowercased title
  const seen = new Set();
  const keyOf = (x) =>
    x.identifiers?.doi
      ? `doi:${x.identifiers.doi.toLowerCase()}`
      : x.identifiers?.pmid
      ? `pmid:${x.identifiers.pmid}`
      : x.source && x.source_id
      ? `${x.source}|${x.source_id}`
      : `title:${(x.title || '').toLowerCase()}`;

  const deduped = [];
  for (const w of out) {
    const k = keyOf(w);
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(w);
    }
  }

  // Sort: year desc, then source
  deduped.sort((a, b) => (b.year || 0) - (a.year || 0) || safeStr(a.source).localeCompare(safeStr(b.source)));
  return deduped;
}

// ---------- Full AI profile (enriched) ----------
// POST /contacts/:contactId/profile
app.post('/contacts/:contactId/profile', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { maxDocs = 15, includePubMed = true, refreshExternal = true } = req.body || {};
    const { name, email } = decodeContactId(contactId);

    // Optionally refresh external artifacts (OpenAlex, Crossref, ORCID, CT.gov, NIH, FDA)
    if (refreshExternal) {
      try {
        await runExternalDiscovery({ name, email });
      } catch (e) {
        console.warn('external discovery failed (non-fatal):', e.message);
      }
    }

    // CGMP docs for this contact (same filters as your earlier code)
    const cgmpQuery = {
      'contacts.name': name,
      'contacts.email': email,
      $or: [
        { dataSource: /CGMP/i },
        { category: /CGMP/i },
        { keywords: { $in: [/CGMP/i, /GMP/i] } },
      ],
    };
    const docs = await Document.find(cgmpQuery)
      .select('question answer summary category keywords regulations risk_level uploadedAt filename')
      .sort({ uploadedAt: -1 })
      .limit(Math.max(5, parseInt(maxDocs, 10)))
      .lean();

    const docSnippets = docs.map((d) => ({
      title: `${d.category}: ${d.question}`,
      excerpt: (d.answer || d.summary || '').substring(0, 1200),
      risk: d.risk_level,
      keywords: (d.keywords || []).slice(0, 5),
      regulations: d.regulations || [],
      uploadedAt: d.uploadedAt,
      filename: d.filename,
    }));

    // PubMed
    const publications = includePubMed ? await searchPubMed(name, 10) : [];

    // External summary + raw artifacts + person index (candidate IDs)
    const contactKey = makeContactKey(name, email);
    const external = await buildExternalSummary(contactKey);
    const artifacts = await ExternalArtifact.find({ contactKey })
      .sort({ year: -1, createdAt: -1 })
      .limit(300)
      .lean()
      .exec();
    const personIdx = await PersonIndex.findOne({ contactKey }).lean().exec();

    // Unified "public works" list (deduped)
    const publicWorks = buildPublicWorks(artifacts, publications);

    // Compute simple “influence score”
    const influence_score = Math.min(
      100,
      Math.round(
        (docs.length * 3) +
        (publicWorks.length * 2) +
        ((external.grants || 0) * 6) +
        ((external.trials || 0) * 5) +
        (external.regulatory_context ? 10 : 0)
      )
    );

    // Optional: build an AI-written summary from your docs + pubs (only if OPENAI_API_KEY set)
    let aiSummary = '';
    let areasFromAI = [];
    let themesFromAI = [];
    if (openai && (docSnippets.length || publications.length)) {
      try {
        const systemPrompt = `You are an analyst creating a concise profile of an FDA reviewer/researcher using CGMP documents and public research. Return a brief summary and succinct lists.`;
        const userPrompt = `Contact: ${name} (${email})

CGMP Docs (${docSnippets.length}):
${docSnippets.map((d, i) => `${i + 1}. ${d.title}
Risk: ${d.risk}
Keywords: ${(d.keywords || []).join(', ')}
Regulations: ${(d.regulations || []).join(', ')}
Excerpt: ${d.excerpt}`).join('\n')}

Publications (${publications.length}):
${publications.map((p, i) => `${i + 1}. ${p.title} — ${p.journal} (${p.year})`).join('\n')}

Topics from external sources: ${(external.topics || []).join(', ')}

Write:
1) A 2–3 sentence professional summary.
2) 3–6 areas_of_expertise (comma-separated).
3) 3–6 themes (comma-separated).`;

        const completion = await openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        });

        const content = completion.choices?.[0]?.message?.content || '';
        // naive parse (expecting a short text block)
        const parts = content.split('\n').map((l) => l.trim()).filter(Boolean);
        aiSummary = parts[0] || content;
        const areasLine = parts.find((l) => /areas_of_expertise/i.test(l)) || '';
        const themesLine = parts.find((l) => /themes/i.test(l)) || '';
        const extractList = (line) =>
          line
            .split(':')
            .slice(1)
            .join(':')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        areasFromAI = extractList(areasLine);
        themesFromAI = extractList(themesLine);
      } catch (e) {
        // non-fatal
      }
    }

    // Build final profile payload
    const profile = {
      name,
      email,
      candidate_ids: {
        orcid: personIdx?.candidateIds?.orcid || null,
        openalex: personIdx?.candidateIds?.openalex || null,
        emailDomain: personIdx?.emailDomain || (email.split('@')[1] || ''),
      },

      // Expertise/topics
      areas_of_expertise: uniq([...(areasFromAI || []), ...(external.topics || [])]).slice(0, 10),
      themes: uniq(themesFromAI).slice(0, 10),

      // Key metrics
      influence_score,
      document_count: docs.length,
      publication_count: publications.length,
      funding_summary: { nih_grant_count: external.grants || 0 },
      trials_summary: { ctgov_trial_count: external.trials || 0 },
      regulatory_context: !!external.regulatory_context,

      // CGMP
      cgmp: {
        recent: docSnippets.slice(0, 10),
      },

      // Publications (PubMed top) + “recent_pubs” from external
      publications: publications.slice(0, 10),
      recent_publications: (external.recent_pubs || []).slice(0, 12),

      // Full public footprint (everything we know; deduped)
      public_works: publicWorks.slice(0, 200),

      // Affiliations rollup from artifacts + index
      affiliations: uniq([
        ...(personIdx?.affiliations || []),
        ...artifacts.flatMap((a) => a?.facets?.affiliations || []),
      ]).slice(0, 20),

      // When
      generated_at: new Date().toISOString(),
    };

    res.json({ success: true, profile });
  } catch (error) {
    console.error('POST /contacts/:id/profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- FDA Reviewers utilities ----------

// GET /reviewers/fda — list FDA reviewers (paginated)
app.get('/reviewers/fda', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
    const skip = (page - 1) * pageSize;

    const pipeline = [
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          name: { $trim: { input: '$contacts.name' } },
          email: { $toLower: { $trim: { input: '$contacts.email' } } },
          title: { $concat: ['$category', ': ', '$question'] },
        },
      },
      { $match: { email: { $regex: /@fda\.hhs\.gov$/i } } },
      {
        $group: {
          _id: { name: '$name', email: '$email' },
          docCount: { $sum: 1 },
          recentTitles: { $push: '$title' },
        },
      },
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          email: '$_id.email',
          docCount: 1,
          recentTitles: { $slice: ['$recentTitles', 5] },
        },
      },
      { $sort: { docCount: -1, name: 1 } },
    ];

    const [rows, countAgg] = await Promise.all([
      Document.aggregate([...pipeline, { $skip: skip }, { $limit: pageSize }]),
      Document.aggregate([...pipeline.slice(0, -1), { $count: 'total' }]),
    ]);
    const total = countAgg[0]?.total || 0;

    const reviewers = rows.map((r) => ({
      ...r,
      contactId: encodeContactId(r.name, r.email),
    }));

    res.json({
      success: true,
      reviewers,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error('GET /reviewers/fda error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /contacts/:contactId/quick-profile — fast (no OpenAI)
app.get('/contacts/:contactId/quick-profile', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { refreshExternal = 'false' } = req.query;
    const { name, email } = decodeContactId(contactId);
    const contactKey = makeContactKey(name, email);

    if (String(refreshExternal) === 'true') {
      try { await runExternalDiscovery({ name, email }); } catch {}
    }

    // CGMP doc count + recent titles
    const docs = await Document.find({
      'contacts.name': name,
      'contacts.email': email,
    })
      .select('category question uploadedAt')
      .sort({ uploadedAt: -1 })
      .limit(6)
      .lean();
    const docCount = await Document.countDocuments({
      'contacts.name': name,
      'contacts.email': email,
    });
    const recentTitles = docs.map((d) => `${d.category}: ${d.question}`);

    const external = await buildExternalSummary(contactKey);
    const pubs = await searchPubMed(name, 5);
    const personIdx = await PersonIndex.findOne({ contactKey }).lean().exec();

    res.json({
      success: true,
      profile: {
        name,
        email,
        candidate_ids: personIdx?.candidateIds || {},
        areas_of_expertise: external.topics || [],
        regulatory_context: !!external.regulatory_context,
        funding_summary: { nih_grant_count: external.grants || 0 },
        trials_summary: { ctgov_trial_count: external.trials || 0 },
        recent_publications: external.recent_pubs || [],
        pubmed_top: pubs,
        cgmp: { doc_count: docCount, recent_titles: recentTitles },
      },
    });
  } catch (err) {
    console.error('GET /contacts/:id/quick-profile error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /reviewers/fda/quick-profiles — batch page of quick profiles
app.get('/reviewers/fda/quick-profiles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '10', 10)));
    const refreshExternal = String(req.query.refreshExternal || 'false') === 'true';

    // Reuse /reviewers/fda aggregation
    const listResp = await Document.aggregate([
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          name: { $trim: { input: '$contacts.name' } },
          email: { $toLower: { $trim: { input: '$contacts.email' } } },
          title: { $concat: ['$category', ': ', '$question'] },
        },
      },
      { $match: { email: { $regex: /@fda\.hhs\.gov$/i } } },
      {
        $group: {
          _id: { name: '$name', email: '$email' },
          docCount: { $sum: 1 },
          recentTitles: { $push: '$title' },
        },
      },
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          email: '$_id.email',
          docCount: 1,
          recentTitles: { $slice: ['$recentTitles', 5] },
        },
      },
      { $sort: { docCount: -1, name: 1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
    ]);
    const countAgg = await Document.aggregate([
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      { $project: { email: { $toLower: { $trim: { input: '$contacts.email' } } } } },
      { $match: { email: { $regex: /@fda\.hhs\.gov$/i } } },
      { $count: 'total' },
    ]);
    const total = countAgg[0]?.total || 0;

    const reviewers = listResp.map((r) => ({
      ...r,
      contactId: encodeContactId(r.name, r.email),
    }));

    // Build quick profiles (sequential to stay inside public API rate limits)
    const profiles = [];
    for (const r of reviewers) {
      const { name, email, contactId } = r;
      const contactKey = makeContactKey(name, email);

      if (refreshExternal) {
        try { await runExternalDiscovery({ name, email }); } catch {}
      }

      const [external, pubs] = await Promise.all([
        buildExternalSummary(contactKey),
        searchPubMed(name, 3),
      ]);

      profiles.push({
        contactId,
        name,
        email,
        docCount: r.docCount,
        recentTitles: r.recentTitles || [],
        areas_of_expertise: external.topics || [],
        regulatory_context: !!external.regulatory_context,
        nih_grant_count: external.grants || 0,
        ctgov_trial_count: external.trials || 0,
        recent_publications: external.recent_pubs || [],
        pubmed_top: pubs || [],
      });
    }

    res.json({
      success: true,
      page,
      pageSize,
      total,
      profiles,
    });
  } catch (err) {
    console.error('GET /reviewers/fda/quick-profiles error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Stats ----------
app.get('/stats', async (_req, res) => {
  try {
    const [totalDocs, totalContactsAgg, riskAgg] = await Promise.all([
      Document.countDocuments(),
      Document.aggregate([
        { $unwind: '$contacts' },
        { $group: { _id: { name: '$contacts.name', email: '$contacts.email' } } },
        { $count: 'total' },
      ]),
      Document.aggregate([{ $group: { _id: '$risk_level', count: { $sum: 1 } } }]),
    ]);

    const totalContacts = totalContactsAgg[0]?.total || 0;
    const riskDistribution = (riskAgg || []).reduce((acc, r) => {
      acc[r._id || 'Unknown'] = r.count;
      return acc;
    }, {});

    res.json({
      success: true,
      stats: { totalDocuments: totalDocs, totalContacts, riskDistribution },
    });
  } catch (error) {
    console.error('GET /stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- Fallbacks ----------
app.use((req, res) => res.status(404).json({ success: false, error: 'Not Found' }));
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err?.response?.data || err.message);
  res.status(500).json({ success: false, error: err.message });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
========================================
🥼 CGMP Contact Profiler Server (integrated)
========================================
Port: ${PORT}
MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Not connected'}
OpenAI: ${process.env.OPENAI_API_KEY ? '✅ Configured' : '—'}
External Intel: /external/:contactId/search • /external/:contactId/artifacts
FDA Reviewers: /reviewers/fda • /reviewers/fda/quick-profiles
Generated: ${new Date().toISOString()}
========================================
`);
});
