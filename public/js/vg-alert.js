// Common alert dialog helper, loaded on every page from views/head.pug.
// Depends on the #alertDialog markup rendered by views/layout.pug.

function showAlert(msg, smallmsg, timer, showCancel) {
    var errMsgElem = document.getElementById("errMsg");
    if (errMsgElem) errMsgElem.textContent = "";
    var infoMsgElem = document.getElementById("infoMsg");
    if (infoMsgElem) infoMsgElem.textContent = "";
    if (showCancel) {
        document.getElementById("alertCancel").style.display = "inline-block";
    } else {
        var temp1 = document.getElementById("alertOk");
        temp1.setAttribute("onclick", "document.getElementById('alertDialog').close();");
        document.getElementById("alertCancel").style.display = "none";
    }
    document.getElementById("alertMessage").innerText = msg;
    if (smallmsg)
        document.getElementById("smallAlert").innerText = smallmsg;
    else
        document.getElementById("smallAlert").innerText = " ";
    if (!document.getElementById("alertDialog").hasAttribute("open"))
        document.getElementById("alertDialog").showModal();
    if (timer)
        setTimeout(function () {
            document.getElementById("alertDialog").close();
        }, timer);
}
