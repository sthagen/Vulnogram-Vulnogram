/* Click handlers for the schema links in cvss4.json that declare
   "action": "<name>". These are specific to the CVSS calculator section, so they
   live here rather than in the shared editor bundle. The copyCvssVector action
   used by this section's Copy button is shared with cve5 and is registered in
   src/js/edit/util.js, next to the cvssjs helpers it relies on.

   Extend window.vgLinkActions instead of assigning it: models/set.js inlines
   this file ahead of jsoneditor.min.js and js/vg-editor.js, so it usually
   creates the object first. Targets are resolved when the handler runs, which is
   why loadVector can live in preload.js and load later.
   Each handler gets {editor, element, event}; the dispatcher in
   src/js/edit/ui.js has already called preventDefault(). */
window.vgLinkActions = Object.assign(window.vgLinkActions || {}, {
    loadVectorFromClipboard: function () {
        navigator.clipboard.readText().then(function (text) {
            loadVector(text, false);
        }).catch(function (err) {
            console.error('Failed to read clipboard: ', err);
        });
    }
});
