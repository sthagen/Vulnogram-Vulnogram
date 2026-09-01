// Copyright (c) 2026 Chandan B N. All rights reserved.

// Remap CNA_private.state for existing cve5 records after the workflow states
// were simplified. The old enum had seven values; they collapse as follows:
//
//   new, open, draft, review  -> draft
//   waiting, pending          -> pending
//   closed                    -> done
//
// Records saved before this change keep their old state string, which is no
// longer a valid enum member (the editor radio can't select it and the list
// filters won't match it). This script rewrites them in place.
//
// Usage (--env-file=.env loads the DB settings the same way the app does):
//   node --env-file=.env scripts/misc/fix_state.js            # apply changes
//   node --env-file=.env scripts/misc/fix_state.js --dry-run  # report what would change, write nothing
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

const STATE_PATH = 'body.CNA_private.state';

// old state value -> new state value
const STATE_MAP = {
    'new': 'draft',
    'open': 'draft',
    'draft': 'draft',
    'review': 'draft',
    'waiting': 'pending',
    'pending': 'pending',
    'closed': 'done'
};

var dryRun = process.argv.slice(2).indexOf('--dry-run') !== -1;

function resolveCollectionName() {
    var opts = optSet('cve5', ['default', 'custom']);
    return (opts && opts.conf && opts.conf.collectionName) ? opts.conf.collectionName : 'cve5';
}

async function fixState() {
    await mongo.connect(conf.database);
    var collectionName = resolveCollectionName();
    var col = mongo.getCollection(collectionName);

    console.log((dryRun ? '[dry-run] ' : '') + 'Scanning collection "' + collectionName + '"...');

    var scanned = 0;
    var updated = 0;
    var unknown = 0;

    var cursor = col.find({});
    while (await cursor.hasNext()) {
        var doc = await cursor.next();
        scanned++;

        var current = _.get(doc, STATE_PATH);
        if (current === undefined) {
            continue;
        }

        var id = _.get(doc, 'body.cveMetadata.cveId') || doc._id;
        var next = STATE_MAP[current];
        if (next === undefined) {
            // Value not in the known old set; leave it alone but report it.
            unknown++;
            console.log('SKIP (unrecognized state "' + current + '"): ' + id);
            continue;
        }
        if (next === current) {
            continue;
        }

        if (dryRun) {
            console.log('[dry-run] ' + id + ': ' + current + ' -> ' + next);
        } else {
            var setOps = {};
            setOps[STATE_PATH] = next;
            await col.updateOne({ _id: doc._id }, { $set: setOps });
        }
        updated++;
    }

    console.log('Scanned ' + scanned + ' documents.');
    console.log((dryRun ? 'Would update ' : 'Updated ') + updated + ' state values.');
    if (unknown > 0) {
        console.log('Left ' + unknown + ' documents with unrecognized state values untouched.');
    }
}

fixState()
    .catch(function (err) {
        console.error('fix_state failed:', err);
        process.exitCode = 1;
    })
    .finally(async function () {
        await mongo.close();
    });
