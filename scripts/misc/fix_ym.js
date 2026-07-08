// Copyright (c) 2026 Chandan B N. All rights reserved.

// Backfill body.CNA_private.publish.{ym,year,month} for existing cve5 records.
//
// These fields are computed in the editor from containers.cna.datePublic and are
// used by the "ym" facet on the CVE list page. Records saved before the watch
// path was fixed (or imported from elsewhere) do not have them, so the ym facet
// shows nothing for those records. This script recomputes them from datePublic.
//
// Usage (--env-file=.env loads the DB settings the same way the app does):
//   node --env-file=.env scripts/misc/fix_ym.js            # apply changes
//   node --env-file=.env scripts/misc/fix_ym.js --dry-run  # report what would change, write nothing
//
// If the MongoDB settings are already in the shell environment (e.g. inside the
// Docker container), drop the --env-file flag. Without either, config/conf.js
// falls back to admin:admin@127.0.0.1:27017 and auth fails.
//
// WARNING: Make a backup of the database before running.

const _ = require('lodash');
const conf = require('../../config/conf');
const optSet = require('../../models/set');
const mongo = require('../../lib/mongo');

// The date the ym/year/month fields are derived from (cve5 schema).
const DATE_PATH = 'body.containers.cna.datePublic';
const YM_PATH = 'body.CNA_private.publish.ym';
const YEAR_PATH = 'body.CNA_private.publish.year';
const MONTH_PATH = 'body.CNA_private.publish.month';

var dryRun = process.argv.slice(2).indexOf('--dry-run') !== -1;

function resolveCollectionName() {
    var opts = optSet('cve5', ['default', 'custom']);
    return (opts && opts.conf && opts.conf.collectionName) ? opts.conf.collectionName : 'cve5';
}

async function fixYM() {
    await mongo.connect(conf.database);
    var collectionName = resolveCollectionName();
    var col = mongo.getCollection(collectionName);

    console.log((dryRun ? '[dry-run] ' : '') + 'Scanning collection "' + collectionName + '"...');

    var scanned = 0;
    var updated = 0;
    var cleared = 0;

    var cursor = col.find({});
    while (await cursor.hasNext()) {
        var doc = await cursor.next();
        scanned++;

        var dt = _.get(doc, DATE_PATH);
        var setOps = {};
        var unsetOps = {};

        if (typeof dt === 'string' && dt.length >= 7) {
            var ym = dt.substr(0, 7);
            var year = dt.substr(0, 4);
            var month = dt.substr(5, 2);
            if (_.get(doc, YM_PATH) !== ym) { setOps[YM_PATH] = ym; }
            if (_.get(doc, YEAR_PATH) !== year) { setOps[YEAR_PATH] = year; }
            if (_.get(doc, MONTH_PATH) !== month) { setOps[MONTH_PATH] = month; }
        } else {
            // No usable date: drop any stale values so the facet stays clean.
            if (_.get(doc, YM_PATH) !== undefined) { unsetOps[YM_PATH] = ''; }
            if (_.get(doc, YEAR_PATH) !== undefined) { unsetOps[YEAR_PATH] = ''; }
            if (_.get(doc, MONTH_PATH) !== undefined) { unsetOps[MONTH_PATH] = ''; }
        }

        var hasSet = Object.keys(setOps).length > 0;
        var hasUnset = Object.keys(unsetOps).length > 0;
        if (!hasSet && !hasUnset) {
            continue;
        }

        var id = _.get(doc, 'body.cveMetadata.cveId') || doc._id;
        var mod = {};
        if (hasSet) { mod['$set'] = setOps; }
        if (hasUnset) { mod['$unset'] = unsetOps; }

        if (dryRun) {
            console.log('[dry-run] ' + id + ' -> ' + JSON.stringify(hasSet ? setOps : unsetOps));
        } else {
            await col.updateOne({ _id: doc._id }, mod);
        }
        if (hasSet) { updated++; } else { cleared++; }
    }

    console.log('Scanned ' + scanned + ' documents.');
    console.log((dryRun ? 'Would update ' : 'Updated ') + updated + ' with a ym value.');
    console.log((dryRun ? 'Would clear ' : 'Cleared ') + cleared + ' stale ym values.');
}

fixYM()
    .catch(function (err) {
        console.error('fix_ym failed:', err);
        process.exitCode = 1;
    })
    .finally(async function () {
        await mongo.close();
    });
