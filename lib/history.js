// Shared audit-trail writer for document collections.
//
// Used by both the HTTP save path (routes/onedoc.js) and the realtime patch
// path (lib/realtime.js) so the two can't drift. Returns the audit-trail
// object synchronously for callers that need it; the DB write is
// fire-and-forget.

const jsonpatch = require('json-patch-extended');

function addModelHistory(model, oldDoc, newDoc) {
    if (oldDoc === null) {
        oldDoc = {
            __v: -1,
            _id: newDoc._id,
            author: newDoc.author,
            updatedAt: newDoc.updatedAt,
            body: {}
        };
    }
    var patch = jsonpatch.compare(oldDoc.body || {}, newDoc.body || {});
    if (!patch.length) {
        return null;
    }
    var auditTrail = {
        parent_id: oldDoc._id,
        updatedAt: newDoc.updatedAt,
        author: newDoc.author,
        __v: oldDoc.__v + 1,
        body: {
            old_version: oldDoc.__v,
            old_author: oldDoc.author,
            old_date: oldDoc.updatedAt,
            patch: patch
        }
    };
    // The mongodb v7 driver is promise-only; the previous callback form was
    // silently ignored (a function passed where options are expected), turning
    // any write failure into an unhandled rejection instead of a logged error.
    Promise.resolve()
        .then(function () {
            return model.insertOne(auditTrail);
        })
        .catch(function (err) {
            console.log('Error: saving history ' + err);
        });
    return auditTrail;
}

module.exports = {
    addModelHistory: addModelHistory
};
