// Vendored from dot-workspace/dot-platform@dc07969 packages/app-switcher. Do not edit here; update dot-platform and re-copy.
// Central registry of Dot Workspace apps. Update URLs here when domains change.
export const dotApps = [
  { id: 'dobal', name: 'Dobal', url: 'https://dobal.vercel.app', icon: '✦', color: '#6d5dfc' },
  { id: 'drivepool', name: 'Drivepool', url: 'https://drivepool-3s9r.onrender.com', icon: '☁', color: '#1a73e8' },
  { id: 'gather', name: 'Gather', url: 'https://golangi.web.app', icon: '❖', color: '#e8710a' },
  { id: 'label-sorter', name: 'Label Sorter', url: 'https://meesho-shipping-label-auto-sorter.vercel.app', icon: '▤', color: '#188038' }
]

export const packageName = '@dot-workspace/app-switcher'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Safe in Node/SSR: only touches the DOM when called in a browser. */
export function defineAppSwitcher(tag = 'dot-app-switcher') {
  if (typeof window === 'undefined' || customElements.get(tag)) return

  class DotAppSwitcher extends HTMLElement {
    connectedCallback() {
      const current = this.getAttribute('current')
      const apps = dotApps
        .map((a) => `<a part="app" href="${esc(a.url)}"${a.id === current ? ' aria-current="page"' : ''}>
          <span class="i" style="background:${esc(a.color)}">${esc(a.icon)}</span>${esc(a.name)}</a>`)
        .join('')
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' })
      root.innerHTML = `<style>
        :host{position:relative;display:inline-block;font:14px system-ui,sans-serif}
        button{width:40px;height:40px;border:0;border-radius:50%;background:none;color:inherit;cursor:pointer;display:grid;place-items:center}
        button:hover,button[aria-expanded=true]{background:rgba(127,127,127,.15)}
        .g{display:grid;grid-template-columns:repeat(3,4px);gap:4px}.g i{width:4px;height:4px;border-radius:50%;background:currentColor}
        .p{position:absolute;right:0;top:46px;z-index:9999;width:288px;padding:12px;border-radius:16px;background:#fff;color:#202124;
           box-shadow:0 4px 24px rgba(0,0,0,.18);display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
        .p[hidden]{display:none}
        a{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border-radius:12px;color:inherit;text-decoration:none;font-size:12px;text-align:center}
        a:hover,a:focus-visible{background:#f1f3f4;outline:none}a[aria-current]{background:#e8f0fe}
        .i{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#fff;font-size:20px}
      </style>
      <button aria-label="Dot Workspace apps" aria-haspopup="true" aria-expanded="false"><span class="g">${'<i></i>'.repeat(9)}</span></button>
      <nav class="p" hidden>${apps}</nav>`
      const btn = root.querySelector('button')
      const panel = root.querySelector('nav')
      const set = (open) => { panel.hidden = !open; btn.setAttribute('aria-expanded', open) }
      btn.onclick = (e) => { e.stopPropagation(); set(panel.hidden) }
      this._close = (e) => { if (e.type === 'click' || e.key === 'Escape') set(false) }
      document.addEventListener('click', this._close)
      document.addEventListener('keydown', this._close)
    }
    disconnectedCallback() {
      document.removeEventListener('click', this._close)
      document.removeEventListener('keydown', this._close)
    }
  }
  customElements.define(tag, DotAppSwitcher)
}
