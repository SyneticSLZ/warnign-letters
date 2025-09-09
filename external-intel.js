// external-intel.js — Public data enrichment for reviewer profiles
// Drop-in module you can mount into your existing Express app.
// It adds: data models, source fetchers (OpenAlex, Crossref, ORCID, ClinicalTrials, NIH RePORTER, FDA),
// a /external/search endpoint, and helpers to enrich your existing /profile output.

const axios = require('axios');
const mongoose = require('mongoose');

// ---------------------------
// Models
// ---------------------------
const ExternalArtifactSchema = new mongoose.Schema({
  contactKey: { type: String, index: true }, // base64 (name|email)
  source: { type: String, index: true },     // 'openalex' | 'crossref' | 'orcid' | 'ctgov' | 'nih_reporter' | 'fda_dashboard' | 'fda_crl'
  source_id: String,
  title: String,
  description: String,
  year: Number,
  url: String,
  facets: {
    affiliations: [String],
    topics: [String],
    grant_numbers: [String],
    journal: String,
    trial_phase: String,
    fda_office: String,
  },
  identifiers: {
    doi: String,
    pmid: String,
    nct: String,
    project_num: String,
  },
  confidence: { type: Number, default: 0.5 }, // 0..1
  fetchedAt: { type: Date, default: () => new Date() },
}, { timestamps: true });

ExternalArtifactSchema.index({ contactKey: 1, source: 1, source_id: 1 }, { unique: false });

const PersonIndexSchema = new mongoose.Schema({
  contactKey: { type: String, unique: true },
  emailDomain: String,
  candidateIds: {
    orcid: String,
    openalex: String,
  },
  affiliations: [String], // normalized org names (optionally RORs later)
  lastRefreshed: Date,
}, { timestamps: true });

const ExternalArtifact = mongoose.models.ExternalArtifact || mongoose.model('ExternalArtifact', ExternalArtifactSchema);
const PersonIndex = mongoose.models.PersonIndex || mongoose.model('PersonIndex', PersonIndexSchema);

// ---------------------------
// Utilities
// ---------------------------
function makeContactKey(name, email) {
  return Buffer.from(`${name}|${email}`.trim()).toString('base64');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(url, cfg = {}, retry = 2) {
  try {
    return await axios.get(url, { timeout: 15000, ...cfg });
  } catch (err) {
    if (retry > 0) {
      await sleep(400 * (3 - retry));
      return safeGet(url, cfg, retry - 1);
    }
    throw err;
  }
}

function yearFromDateStr(s) {
  if (!s) return undefined;
  const m = /\d{4}/.exec(String(s));
  return m ? Number(m[0]) : undefined;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function scoreNameHit(target, candidate) {
  // Tiny heuristic: exact case-insensitive match = 0.95, loose contains = 0.6
  if (!target || !candidate) return 0.4;
  const t = target.toLowerCase();
  const c = candidate.toLowerCase();
  if (t === c) return 0.95;
  if (c.includes(t) || t.includes(c)) return 0.6;
  return 0.45;
}

// ---------------------------
// Source fetchers (no API keys required; ORCID token optional)
// ---------------------------
const ORCID_TOKEN = process.env.ORCID_TOKEN || null; // optional

async function findOrcidIdByNameAffil(name, affiliation) {
  const qParts = [];
  const [given, ...rest] = (name || '').split(' ').filter(Boolean);
  const family = rest.pop() || '';
  if (given) qParts.push(`given-names:${JSON.stringify(given)}`);
  if (family) qParts.push(`family-name:${JSON.stringify(family)}`);
  if (affiliation) qParts.push(`affiliation-org-name:${JSON.stringify(affiliation)}`);
  const q = qParts.join(' AND ');
  const headers = { Accept: 'application/json' };
  if (ORCID_TOKEN) headers.Authorization = `Bearer ${ORCID_TOKEN}`;
  const url = `https://pub.orcid.org/v3.0/expanded-search/?q=${encodeURIComponent(q)}&rows=5`;
  const { data } = await safeGet(url, { headers });
  const docs = data?.expandedResult || [];
  const best = docs.map(d => ({
    orcid: d['orcid-id'],
    name: `${d['given-names']} ${d['family-names']}`.trim(),
    affiliation: d['institution-name'],
    score: scoreNameHit(name, `${d['given-names']} ${d['family-names']}`)
  })).sort((a,b)=>b.score-a.score)[0];
  return best?.orcid || null;
}

async function fetchOrcidWorks(orcid) {
  if (!orcid) return [];
  const headers = { Accept: 'application/json' };
  if (ORCID_TOKEN) headers.Authorization = `Bearer ${ORCID_TOKEN}`;
  const { data } = await safeGet(`https://pub.orcid.org/v3.0/${orcid}/works`, { headers });
  const groups = data?.group || [];
  const out = [];
  for (const g of groups) {
    const summary = g['work-summary']?.[0];
    if (!summary) continue;
    out.push({
      source: 'orcid',
      source_id: String(summary['put-code']),
      title: summary['title']?.title?.value,
      year: summary['publication-date'] ? yearFromDateStr(Object.values(summary['publication-date']).join('-')) : undefined,
      url: summary['url']?.value,
      identifiers: {
        doi: summary['external-ids']?.['external-id']?.find(e => e['external-id-type']==='doi')?.['external-id-value']
      }
    });
  }
  return out;
}

async function findOpenAlexAuthorId(name, affiliation) {
  const url = `https://api.openalex.org/authors?search=${encodeURIComponent(name)}&per_page=25${affiliation ? `&filter=last_known_institution.display_name.search:${encodeURIComponent(affiliation)}`:''}`;
  const { data } = await safeGet(url);
  const results = data?.results || [];
  const scored = results.map(a => ({ id: a.id, display_name: a.display_name, inst: a.last_known_institution?.display_name, score: scoreNameHit(name, a.display_name) }));
  return scored.sort((a,b)=>b.score-a.score)[0]?.id || null;
}

async function fetchOpenAlexWorks(authorId) {
  if (!authorId) return [];
  const url = `https://api.openalex.org/works?filter=author.id:${encodeURIComponent(authorId)}&per_page=25&sort=cited_by_count:desc`;
  const { data } = await safeGet(url);
  return (data?.results || []).map(w => ({
    source: 'openalex',
    source_id: w.id,
    title: w.title,
    year: yearFromDateStr(w.publication_year || w.from_publication_date),
    url: w.id,
    facets: {
      topics: (w?.topics || w?.concepts || []).slice(0,8).map(c => c.display_name)
    },
    identifiers: { doi: w.doi }
  }));
}

async function fetchCrossrefWorksByAuthor(name) {
  const url = `https://api.crossref.org/works?query.author=${encodeURIComponent(name)}&rows=25&select=DOI,title,author,issued,URL,container-title`;
  const { data } = await safeGet(url);
  const items = data?.message?.items || [];
  return items.map(it => ({
    source: 'crossref',
    source_id: it.DOI || it.URL,
    title: Array.isArray(it.title) ? it.title[0] : it.title,
    year: yearFromDateStr(it.issued?.['date-parts']?.[0]?.[0]),
    url: it.URL,
    facets: { journal: Array.isArray(it['container-title']) ? it['container-title'][0] : it['container-title'] },
    identifiers: { doi: it.DOI }
  }));
}

async function fetchCtGov(name, affiliation) {
  const q = encodeURIComponent([name, affiliation].filter(Boolean).join(' '));
  const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${q}&pageSize=25`;
  const { data } = await safeGet(url);
  const studies = data?.studies || [];
  return studies.map(s => ({
    source: 'ctgov',
    source_id: s.protocolSection?.identificationModule?.nctId,
    title: s.protocolSection?.identificationModule?.officialTitle || s.protocolSection?.identificationModule?.briefTitle,
    year: yearFromDateStr(s.protocolSection?.statusModule?.startDateStruct?.date),
    url: `https://clinicaltrials.gov/study/${s.protocolSection?.identificationModule?.nctId}`,
    facets: { trial_phase: s.protocolSection?.designModule?.phases?.[0] },
    identifiers: { nct: s.protocolSection?.identificationModule?.nctId }
  }));
}

async function fetchNIHReporter(name, affiliation) {
  const body = {
    criteria: {
      pi_names: [name],
      ...(affiliation ? { org_names: [affiliation] } : {})
    },
    include_fields: ["project_num","org_name","project_title","contact_pi_name","award_amount","fiscal_year","project_start","project_end","project_num_split"]
  };
  const { data } = await axios.post('https://api.reporter.nih.gov/v2/projects/search', body, { timeout: 20000 });
  const items = data?.results || [];
  return items.map(it => ({
    source: 'nih_reporter',
    source_id: it.project_num,
    title: it.project_title,
    year: yearFromDateStr(it.fiscal_year || it.project_start),
    url: `https://reporter.nih.gov/search/A3?pi=${encodeURIComponent(name)}`,
    facets: { affiliations: uniq([it.org_name]) },
    identifiers: { project_num: it.project_num }
  }));
}

async function fetchFdaInspections(officeLike) {
  if (!officeLike) return [];
  const url = `https://api-datadashboard.fda.gov/v1/inspections_classifications?search=${encodeURIComponent(officeLike)}&limit=25`;
  try {
    const { data } = await safeGet(url);
    const rows = Array.isArray(data?.results) ? data.results : [];
    return rows.map(r => ({
      source: 'fda_dashboard',
      source_id: String(r.id || r._id || r.fei || Math.random()),
      title: `Inspection: ${r.firm_name || r.firm || 'Unknown'}`,
      description: [r.city, r.state, r.country, r.inspection_end_date].filter(Boolean).join(', '),
      year: yearFromDateStr(r.inspection_end_date),
      url: 'https://datadashboard.fda.gov/ora/cd/inspections.htm',
      facets: { fda_office: r.responsible_office || r.district || officeLike }
    }));
  } catch {
    return [];
  }
}

async function fetchFdaCRLs(programOrOfficeLike) {
  const search = encodeURIComponent(programOrOfficeLike || '');
  const url = `https://api.fda.gov/transparency/completeresponseletters.json?search=${search}&limit=25`;
  try {
    const { data } = await safeGet(url);
    const items = data?.results || [];
    return items.map(it => ({
      source: 'fda_crl',
      source_id: String(it.id || it.application_number || Math.random()),
      title: `CRL: ${it.sponsor_name || it.product_name || 'Unknown'}`,
      year: yearFromDateStr(it.issued_date || it.date),
      url: 'https://www.fda.gov/drugs/nda-and-bla-approvals/complete-response-letters',
      facets: { fda_office: it.center || programOrOfficeLike }
    }));
  } catch {
    return [];
  }
}

// ---------------------------
// Normalization & upsert
// ---------------------------
function dedupeArtifacts(list) {
  const key = a => `${a.source}|${a.source_id || a.identifiers?.doi || a.identifiers?.nct || a.identifiers?.pmid || a.identifiers?.project_num}`;
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const k = key(a);
    if (k && !seen.has(k)) { seen.add(k); out.push(a); }
  }
  return out;
}

function bulkUpserts(contactKey, artifacts) {
  return artifacts.map(a => ({
    updateOne: {
      filter: { contactKey, source: a.source, source_id: a.source_id },
      update: { $set: { ...a, contactKey } },
      upsert: true,
    }
  }));
}

// ---------------------------
// Core orchestrator
// ---------------------------
async function runExternalDiscovery({ name, email }) {
  const emailDomain = (email || '').split('@')[1] || '';
  const affiliationHint = emailDomain.includes('fda.hhs.gov') ? 'Food and Drug Administration' : '';
  const contactKey = makeContactKey(name, email);

  // Resolve stable IDs
  const [orcidId, openalexId] = await Promise.all([
    findOrcidIdByNameAffil(name, affiliationHint).catch(()=>null),
    findOpenAlexAuthorId(name, affiliationHint).catch(()=>null),
  ]);

  // Fetch artifacts in parallel
  const [orcidWorks, oaWorks, xrefWorks, ctgov, reporter, fdaInsp, fdaCrl] = await Promise.all([
    fetchOrcidWorks(orcidId).catch(()=>[]),
    fetchOpenAlexWorks(openalexId).catch(()=>[]),
    fetchCrossrefWorksByAuthor(name).catch(()=>[]),
    fetchCtGov(name, affiliationHint).catch(()=>[]),
    fetchNIHReporter(name, affiliationHint).catch(()=>[]),
    fetchFdaInspections(affiliationHint).catch(()=>[]),
    fetchFdaCRLs(affiliationHint).catch(()=>[]),
  ]);

  const artifacts = dedupeArtifacts([
    ...orcidWorks,
    ...oaWorks,
    ...xrefWorks,
    ...ctgov,
    ...reporter,
    ...fdaInsp,
    ...fdaCrl,
  ]).map(a => ({ ...a, confidence: a.confidence ?? 0.7 }));

  // Upsert artifacts
  if (artifacts.length) {
    await ExternalArtifact.bulkWrite(bulkUpserts(contactKey, artifacts));
  }

  // Update person index
  const idx = await PersonIndex.findOneAndUpdate(
    { contactKey },
    { $set: {
      emailDomain,
      candidateIds: { orcid: orcidId || undefined, openalex: openalexId || undefined },
      affiliations: uniq([affiliationHint]),
      lastRefreshed: new Date()
    }},
    { upsert: true, new: true }
  );

  return { artifactsCount: artifacts.length, personIndex: idx };
}

// ---------------------------
// Profile enrichment helper
// ---------------------------
async function buildExternalSummary(contactKey) {
  const rows = await ExternalArtifact.find({ contactKey }).sort({ createdAt: -1 }).limit(200).lean();
  const topics = uniq(rows.flatMap(r => r.facets?.topics || [])).slice(0, 10);
  const grants = rows.filter(r => r.source==='nih_reporter').length;
  const trials = rows.filter(r => r.source==='ctgov').length;
  const hasFdaCtx = rows.some(r => r.source==='fda_dashboard' || r.source==='fda_crl');
  const recentPubs = rows
    .filter(r => ['openalex','crossref','orcid'].includes(r.source))
    .sort((a,b)=> (b.year||0)-(a.year||0))
    .slice(0,5)
    .map(r => ({ title: r.title, year: r.year, url: r.url }));
  return { topics, grants, trials, regulatory_context: hasFdaCtx, recent_pubs: recentPubs };
}

// ---------------------------
// Router
// ---------------------------
const { Router } = require('express');
const router = Router();

// GET /external/:contactId/search — run discovery and persist artifacts
router.get('/external/:contactId/search', async (req, res) => {
  try {
    const { contactId } = req.params;
    const [name, email] = Buffer.from(contactId, 'base64').toString().split('|');
    const result = await runExternalDiscovery({ name, email });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('external search error', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /external/:contactId/artifacts — list what we have stored
router.get('/external/:contactId/artifacts', async (req, res) => {
  try {
    const { contactId } = req.params;
    const rows = await ExternalArtifact.find({ contactKey: contactId }).sort({ fetchedAt: -1 }).limit(200).lean();
    res.json({ success: true, count: rows.length, artifacts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = {
  router,
  ExternalArtifact,
  PersonIndex,
  runExternalDiscovery,
  buildExternalSummary,
  makeContactKey,
};
