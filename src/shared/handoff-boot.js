/* Adds "Send to ▸" beside the existing Copy prompt button in both builds. */
(() => {
  const copyButton = document.getElementById('btnCopy');
  if (!copyButton || !window.GameVolleyHandoffUi) return;
  const desktop = !!(window.pv && typeof window.pv.hermesStart === 'function');

  const ui = window.GameVolleyHandoffUi.createHandoffUi({
    web: !desktop,
    bridge: {
      copy: (text) => window.pv.copy(text),
      open: (url) => window.pv.openUrl(url),
      hermes: (text) => window.pv.hermesStart(text),
    },
  });

  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'ghost';
  sendButton.id = 'btnSendTo';
  sendButton.textContent = 'Send to ▸';
  sendButton.title = 'Hand the approved prompt to a coding agent (Hermes starts directly, never via Discord)';
  sendButton.addEventListener('click', () => {
    const final = document.getElementById('final');
    ui.open(final ? final.value : '');
  });
  copyButton.parentElement.insertBefore(sendButton, copyButton.nextSibling);
})();
