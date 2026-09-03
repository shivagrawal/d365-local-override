chrome.runtime.onMessage.addListener(message => {
  const id = 'pcf-local-override-indicator';
  document.getElementById(id)?.remove();
  if (!message.active) return;
  const labels = { pcf: 'LOCAL PCF', script: 'LOCAL JS', html: 'LOCAL HTML' };
  const b = document.createElement('button');
  b.id = id;
  b.textContent = labels[message.resourceType] || 'LOCAL OVERRIDE';
  b.onclick = () => b.remove();
  Object.assign(b.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483647,
    border: 0, borderRadius: '4px', padding: '7px 10px',
    background: '#b42318', color: '#fff', font: '700 12px system-ui', cursor: 'pointer'
  });
  document.documentElement.appendChild(b);
});
