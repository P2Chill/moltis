// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded affix "><a href="index.html">Introduction</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Getting Started</li><li class="chapter-item expanded "><a href="quickstart.html"><strong aria-hidden="true">1.</strong> Quickstart</a></li><li class="chapter-item expanded "><a href="installation.html"><strong aria-hidden="true">2.</strong> Installation</a></li><li class="chapter-item expanded "><a href="comparison.html"><strong aria-hidden="true">3.</strong> Comparison</a></li><li class="chapter-item expanded "><a href="configuration.html"><strong aria-hidden="true">4.</strong> Configuration</a></li><li class="chapter-item expanded "><a href="local-validation.html"><strong aria-hidden="true">5.</strong> Local Validation</a></li><li class="chapter-item expanded "><a href="e2e-testing.html"><strong aria-hidden="true">6.</strong> End-to-End Testing</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Features</li><li class="chapter-item expanded "><a href="providers.html"><strong aria-hidden="true">7.</strong> LLM Providers</a><a class="toggle"><div>❱</div></a></li><li><ol class="section"><li class="chapter-item "><a href="anthropic-oauth.html"><strong aria-hidden="true">7.1.</strong> Anthropic OAuth (FAQ)</a></li></ol></li><li class="chapter-item expanded "><a href="mcp.html"><strong aria-hidden="true">8.</strong> MCP Servers</a></li><li class="chapter-item expanded "><a href="memory.html"><strong aria-hidden="true">9.</strong> Memory</a><a class="toggle"><div>❱</div></a></li><li><ol class="section"><li class="chapter-item "><a href="memory-comparison.html"><strong aria-hidden="true">9.1.</strong> Moltis vs OpenClaw</a></li></ol></li><li class="chapter-item expanded "><a href="hooks.html"><strong aria-hidden="true">10.</strong> Hooks</a></li><li class="chapter-item expanded "><a href="local-llm.html"><strong aria-hidden="true">11.</strong> Local LLMs</a></li><li class="chapter-item expanded "><a href="sandbox.html"><strong aria-hidden="true">12.</strong> Sandbox</a><a class="toggle"><div>❱</div></a></li><li><ol class="section"><li class="chapter-item "><a href="trusted-network.html"><strong aria-hidden="true">12.1.</strong> Trusted Network</a></li></ol></li><li class="chapter-item expanded "><a href="voice.html"><strong aria-hidden="true">13.</strong> Voice</a></li><li class="chapter-item expanded "><a href="channels.html"><strong aria-hidden="true">14.</strong> Channels</a><a class="toggle"><div>❱</div></a></li><li><ol class="section"><li class="chapter-item "><a href="discord.html"><strong aria-hidden="true">14.1.</strong> Discord</a></li><li class="chapter-item "><a href="whatsapp.html"><strong aria-hidden="true">14.2.</strong> WhatsApp</a></li></ol></li><li class="chapter-item expanded "><a href="browser-automation.html"><strong aria-hidden="true">15.</strong> Browser Automation</a></li><li class="chapter-item expanded "><a href="caldav.html"><strong aria-hidden="true">16.</strong> CalDAV (Calendars)</a></li><li class="chapter-item expanded "><a href="graphql.html"><strong aria-hidden="true">17.</strong> GraphQL API</a></li><li class="chapter-item expanded "><a href="session-state.html"><strong aria-hidden="true">18.</strong> Session State</a></li><li class="chapter-item expanded "><a href="session-branching.html"><strong aria-hidden="true">19.</strong> Session Branching</a></li><li class="chapter-item expanded "><a href="scheduling.html"><strong aria-hidden="true">20.</strong> Scheduling (Cron Jobs)</a></li><li class="chapter-item expanded "><a href="skill-tools.html"><strong aria-hidden="true">21.</strong> Skill Self-Extension</a></li><li class="chapter-item expanded "><a href="mobile-pwa.html"><strong aria-hidden="true">22.</strong> Mobile PWA</a></li><li class="chapter-item expanded "><a href="native-swift-embedding.html"><strong aria-hidden="true">23.</strong> Native Swift Embedding (POC)</a></li><li class="chapter-item expanded "><a href="macos-app-ffi-bridge.html"><strong aria-hidden="true">24.</strong> macOS App FFI Bridge (WIP)</a></li><li class="chapter-item expanded "><a href="openclaw-import.html"><strong aria-hidden="true">25.</strong> OpenClaw Import</a></li><li class="chapter-item expanded "><a href="nodes.html"><strong aria-hidden="true">26.</strong> Multi-Node</a></li><li class="chapter-item expanded "><a href="service.html"><strong aria-hidden="true">27.</strong> Service Management</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Security</li><li class="chapter-item expanded "><a href="authentication.html"><strong aria-hidden="true">28.</strong> Authentication</a></li><li class="chapter-item expanded "><a href="vault.html"><strong aria-hidden="true">29.</strong> Encryption at Rest (Vault)</a></li><li class="chapter-item expanded "><a href="security.html"><strong aria-hidden="true">30.</strong> Security Architecture</a></li><li class="chapter-item expanded "><a href="skills-security.html"><strong aria-hidden="true">31.</strong> Third-Party Skills Security</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Deployment</li><li class="chapter-item expanded "><a href="docker.html"><strong aria-hidden="true">32.</strong> Docker</a></li><li class="chapter-item expanded "><a href="cloud-deploy.html"><strong aria-hidden="true">33.</strong> Cloud Deploy</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Architecture</li><li class="chapter-item expanded "><a href="system-prompt.html"><strong aria-hidden="true">34.</strong> System Prompt</a></li><li class="chapter-item expanded "><a href="streaming.html"><strong aria-hidden="true">35.</strong> Streaming</a></li><li class="chapter-item expanded "><a href="sqlite-migration.html"><strong aria-hidden="true">36.</strong> SQLite Migrations</a></li><li class="chapter-item expanded "><a href="metrics-and-tracing.html"><strong aria-hidden="true">37.</strong> Metrics &amp; Tracing</a></li><li class="chapter-item expanded "><a href="tool-registry.html"><strong aria-hidden="true">38.</strong> Tool Registry</a></li><li class="chapter-item expanded "><a href="agent-presets.html"><strong aria-hidden="true">39.</strong> Agent Presets</a></li><li class="chapter-item expanded "><a href="session-tools.html"><strong aria-hidden="true">40.</strong> Session Tools</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Reference</li><li class="chapter-item expanded "><a href="changelog.html"><strong aria-hidden="true">41.</strong> Changelog</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0].split("?")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
