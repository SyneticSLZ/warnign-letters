// contacts-profile-route.js
// Full implementation of POST /contacts/:contactId/profile
// - Decodes contactId (base64 of "Name|email")
// - Pulls INTERNAL CGMP snippets if your CGMP model exists (fails open if it doesn't)
// - Enriches with PUBLIC data via external-intel.js (topics, grants, trials, pubs, FDA context)
// - Fetches PubMed publications by author name (top 10) to complement Crossref/OpenAlex
// - Returns a single consolidated JSON profile

const express = require('express');
const axios = require('axios');
const router = express.Router();

// Bring in external intelligence helpers
const {
  buildExternalSummary,
  makeContactKey,
} = require('./external-intel');

// ---------------------------
// Helpers
// ---------------------------
function decodeContactId(contactId) {
  const [name, email] = Buffer.from(contactId, 'base64').toString().split('|');
  return { name: (name || '').trim(), email: (email || '').trim() };
}

function uniq(arr) { return Array.from(new Set((arr || []).filter(Boolean))); }

function yearFromDateStr(s) {
  if (!s) return undefined;
  const m = /\d{4}/.exec(String(s));
  return m ? Number(m[0]) : undefined;
}

// ---------------------------
// Optional: INTERNAL CGMP lookup
// This fails open ([]) if no model named CGMPDoc is registered.
// ---------------------------
async function getCgmpSnippetsForReviewer(name) {
  try {
    const mongoose = require('mongoose');
    const CGMPDoc = mongoose.models.CGMPDoc || mongoose.model('CGMPDoc');
    // Prefer text index if present
    const docs = await CGMPDoc.find({ $text: { $search: `\"${name}\" ${name.split(' ')[0]}` } })
      .select({ title: 1, url: 1, snippet: 1, updatedAt: 1, content: 1 })
      .limit(10).lean();
    if (docs && docs.length) {
      return docs.map(d => ({
        title: d.title,
        url: d.url,
        snippet: d.snippet || (d.content || '').slice(0, 300),
        updatedAt: d.updatedAt
      }));
    }
    // Fallback regex search if no text index or no results
    const rx = new RegExp(name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    const fallback = await CGMPDoc.find({ $or: [{ title: rx }, { snippet: rx }, { content: rx }] })
      .select({ title: 1, url: 1, snippet: 1, updatedAt: 1, content: 1 })
      .limit(10).lean();
    return (fallback || []).map(d => ({
      title: d.title,
      url: d.url,
      snippet: d.snippet || (d.content || '').slice(0, 300),
      updatedAt: d.updatedAt
    }));
  } catch (_) {
    return [];
  }
}

// ---------------------------
// PubMed by author (NCBI E-utilities)
// ---------------------------
async function fetchPubMedByAuthor(authorName, max = 10) {
  try {
    const term = encodeURIComponent(`${authorName}[Author]`);
    const esearch = await axios.get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${max}&term=${term}`, { timeout: 15000 });
    const ids = (esearch.data?.esearchresult?.idlist || []).slice(0, max);
    if (ids.length === 0) return [];
    const idStr = ids.join(',');
    const esummary = await axios.get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${idStr}`, { timeout: 15000 });
    const result = esummary.data?.result || {};
    const records = ids.map(id => result[id]).filter(Boolean);
    return records.map(r => ({
      source: 'pubmed',
      pmid: r.uid,
      title: r.title,
      year: yearFromDateStr(r.pubdate || r.epubdate),
      url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`
    }));
  } catch (_) {
    return [];
  }
}

// ---------------------------
/* POST /contacts/:contactId/profile */
router.post('/contacts/:contactId/profile', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { name, email } = decodeContactId(contactId);

    // Basic shell
    const profile = {
      name,
      email,
      sources: {
        internal: { cgmp_docs: 0 },
        public: { pubmed: 0, external_artifacts: true }
      },
      areas_of_expertise: [],
      regulatory_context: false,
      recent_publications: [],
      funding_summary: {},
      trials_summary: {},
      provenance: []
    };

    // INTERNAL: CGMP snippets
    const cgmp = await getCgmpSnippetsForReviewer(name);
    profile.sources.internal.cgmp_docs = cgmp.length;
    profile.cgmp_documents = cgmp;
    profile.provenance.push({ type: 'cgmp', count: cgmp.length });

    // PUBLIC rollup from external-intel
    const contactKey = makeContactKey(name, email);
    const external = await buildExternalSummary(contactKey);

    // areas/topics
    profile.areas_of_expertise = uniq([ ...(profile.areas_of_expertise || []), ...(external.topics || []) ]).slice(0, 8);
    profile.regulatory_context = !!external.regulatory_context;

    // PubMed list
    const pubmed = await fetchPubMedByAuthor(name, 10);

    // recent pubs (dedupe by title)
    const combinedPubs = [
      ...(external.recent_pubs || []).map(p => ({ title: p.title, year: p.year, url: p.url })),
      ...pubmed.map(p => ({ title: p.title, year: p.year, url: p.url }))
    ];
    const seen = new Set();
    profile.recent_publications = combinedPubs.filter(p => {
      const k = (p.title || '').toLowerCase();
      if (!k || seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 12);

    // counts
    profile.funding_summary.nih_grant_count = external.grants || 0;
    profile.trials_summary.ctgov_trial_count = external.trials || 0;

    profile.sources.public.pubmed = pubmed.length;
    profile.provenance.push({ type: 'pubmed', count: pubmed.length });
    profile.provenance.push({ type: 'external', topics: (external.topics || []).length, grants: external.grants || 0, trials: external.trials || 0 });

    res.json({ success: true, profile });
  } catch (err) {
    console.error('profile error', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { router };
