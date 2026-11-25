/* Adds the "Scaffold" action beside Send to ▸ in the result panel of both builds. */
(() => {
  const anchor = document.getElementById('btnSendTo') || document.getElementById('btnCopy');
  if (!anchor || !window.GameVolleyScaffoldUi) return;
  const desktop = !!(window.pv && typeof window.pv.scaffoldWrite === 'function');
  const web = window.GameVolleyScaffoldWeb;

  const common = {
    generate: (prompt, cycles, model, feedback) => window.pv.utility({
      kind: 'scaffold', prompt, cycles, model,
      instruction: feedback ? String(feedback).slice(0, 800) : '', provider: 'openrouter',
    }),
    review: (manifest, cycles, model) => window.pv.utility({
      kind: 'scaffold-critic', prompt: manifest, cycles, model, provider: 'openrouter',
    }),
  };
  const bridge = desktop ? Object.assign(common, {
    pickDir: () => window.pv.scaffoldPickDir(),
    write: (files, destination, merge) => window.pv.scaffoldWrite(destination, files, merge),
    downloadZip: async () => ({ count: 0 }),
  }) : Object.assign(common, {
    pickDir: () => web.pick(),
    write: (files, _destination, merge) => web.write(files, merge),
    downloadZip: (files) => web.downloadZip(files),
  });

  const ui = window.GameVolleyScaffoldUi.createScaffoldUi({
    bridge,
    web: !desktop,
    model: () => {
      const field = document.getElementById('author');
      return field ? field.value : '';
    },
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.id = 'btnScaffold';
  button.textContent = '🏗 Scaffold';
  button.title = 'Have the Writer model produce a project folder and a todo.md handoff';
  button.addEventListener('click', () => {
    const final = document.getElementById('final');
    ui.open(final ? final.value : '');
  });
  anchor.parentElement.insertBefore(button, anchor.nextSibling);
})();
