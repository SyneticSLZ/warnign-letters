// reviewers-route.js
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const { makeContactKey, buildExternalSummary } = require('./external-intel');

const router = express.Router();

// Reuse your existing model registration from server.js:
const Document = mongoose.model('Document');

// helpers
const encodeId = (name, email) => Buffer.from(`${name}|${email}`).toString('base64');
const decodeId = (id) => {
  const [name, email] = Buffer.from(id, 'base64').toString().split('|');
  return { name, email };
};

// GET /reviewers/fda  — paged list of unique @fda.hhs.gov contacts
router.get('/reviewers/fda', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
    const skip = (page - 1) * pageSize;

    const base = [
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          name: { $trim: { input: '$contacts.name' } },
          email: { $toLower: { $trim: { input: '$contacts.email' } } },
          title: { $concat: ['$category', ': ', '$question'] }
        }
      },
      { $match: { email: { $regex: /@fda\.hhs\.gov$/i } } },
      {
        $group: {
          _id: { name: '$name', email: '$email' },
          docCount: { $sum: 1 },
          recentTitles: { $push: '$title' }
        }
      },
      { $sort: { docCount: -1, '_id.name': 1 } },
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          email: '$_id.email',
          docCount: 1,
          recentTitles: { $slice: ['$recentTitles', 5] }
        }
      }
    ];

    const reviewers = await Document.aggregate([...base, { $skip: skip }, { $limit: pageSize }]);
    const totalArr = await Document.aggregate([...base.slice(0, -2), { $count: 'total' }]);
    const total = totalArr[0]?.total || 0;

    res.json({
      success: true,
      reviewers: reviewers.map(r => ({ ...r, contactId: encodeId(r.name, r.email) })),
      pagination: {
        page, pageSize, total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (e) {
    console.error('/reviewers/fda', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /reviewers/fda/quick-profiles — quick cards for current page
router.get('/reviewers/fda/quick-profiles', async (req, res) => {
  try {
    // Reuse the listing above to get the same page of contacts
    req.query.page = req.query.page || '1';
    req.query.pageSize = req.query.pageSize || '9';

    // Quick internal call to our own handler logic:
    const page = Math.max(1, parseInt(req.query.page, 10));
    const pageSize = Math.min(24, Math.max(1, parseInt(req.query.pageSize, 10)));
    const skip = (page - 1) * pageSize;

    const base = [
      { $unwind: { path: '$contacts', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          name: { $trim: { input: '$contacts.name' } },
          email: { $toLower: { $trim: { input: '$contacts.email' } } },
          title: { $concat: ['$category', ': ', '$question'] }
        }
      },
      { $match: { email: { $regex: /@fda\.hhs\.gov$/i } } },
      {
        $group: {
          _id: { name: '$name', email: '$email' },
          docCount: { $sum: 1 },
          recentTitles: { $push: '$title' }
        }
      },
      { $sort: { docCount: -1, '_id.name': 1 } },
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          email: '$_id.email',
          docCount: 1
        }
      }
    ];

    const ppl = await Document.aggregate([...base, { $skip: skip }, { $limit: pageSize }]);

    // Enrich each with a tiny external summary + PubMed top 3
    const profiles = await Promise.all(
      ppl.map(async person => {
        const contactId = encodeId(person.name, person.email);
        const key = makeContactKey(person.name, person.email);
        let ext = {};
        try { ext = await buildExternalSummary(key); } catch {}
        let pubmed_top = [];
        try {
          const es = await axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
            params: { db: 'pubmed', term: `${person.name}[Author]`, retmode: 'json', retmax: 3 },
            timeout: 12000
          });
          const ids = es.data?.esearchresult?.idlist || [];
          if (ids.length) {
            const sum = await axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
              params: { db: 'pubmed', id: ids.join(','), retmode: 'json' },
              timeout: 12000
            });
            const r = sum.data?.result || {};
            pubmed_top = ids.map(id => ({
              pmid: id,
              title: r[id]?.title || '',
              journal: r[id]?.fulljournalname || '',
              year: (r[id]?.pubdate || '').slice(0, 4)
            }));
          }
        } catch {}

        return {
          name: person.name,
          email: person.email,
          docCount: person.docCount,
          contactId,
          areas_of_expertise: ext.topics || [],
          pubmed_top
        };
      })
    );

    res.json({ success: true, profiles });
  } catch (e) {
    console.error('/reviewers/fda/quick-profiles', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /contacts/:contactId/quick-profile — used by “Quick” button
router.get('/contacts/:contactId/quick-profile', async (req, res) => {
  try {
    const { name, email } = decodeId(req.params.contactId);

    // CGMP doc count
    const doc_count = await Document.countDocuments({
      'contacts.name': name,
      'contacts.email': email
    });

    // PubMed top 3
    let pubmed_top = [];
    try {
      const es = await axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
        params: { db: 'pubmed', term: `${name}[Author]`, retmode: 'json', retmax: 3 },
        timeout: 12000
      });
      const ids = es.data?.esearchresult?.idlist || [];
      if (ids.length) {
        const sum = await axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
          params: { db: 'pubmed', id: ids.join(','), retmode: 'json' },
          timeout: 12000
        });
        const r = sum.data?.result || {};
        pubmed_top = ids.map(id => ({
          pmid: id,
          title: r[id]?.title || '',
          journal: r[id]?.fulljournalname || '',
          year: (r[id]?.pubdate || '').slice(0, 4)
        }));
      }
    } catch {}

    // External signals
    const key = makeContactKey(name, email);
    let ext = {};
    try { ext = await buildExternalSummary(key); } catch {}

    const profile = {
      name, email,
      cgmp: { doc_count },
      areas_of_expertise: ext.topics || [],
      recent_publications: ext.recent_pubs || [],
      funding_summary: { nih_grant_count: ext.grants || 0 },
      trials_summary: { ctgov_trial_count: ext.trials || 0 },
      pubmed_top
    };
    res.json({ success: true, profile });
  } catch (e) {
    console.error('/contacts/:contactId/quick-profile', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = { router };
