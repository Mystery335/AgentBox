type Page = 'dashboard' | 'new' | 'activity' | 'validation' | 'documentation';
const links: { page: Page; href: string; label: string }[] = [
  { page: 'dashboard', href: '#/workspace', label: '▦ Dashboard' },
  { page: 'new', href: '#/workspace/new', label: '+ Set up modernization' },
  { page: 'activity', href: '#/workspace/activity', label: '◇ Agent activity' },
  { page: 'validation', href: '#/workspace/validation', label: '✓ Validation' },
  { page: 'documentation', href: '#/workspace/documentation', label: '▤ Documentation' },
];

export default function WorkspaceSidebar({ current }: { current: Page }) {
  return <aside className="la-sidebar">
    <a href="#" className="brand">▣ AgentBox</a>
    <p>WORKSPACE</p>
    <nav aria-label="Workspace navigation">
      {links.map(link => <a key={link.page} href={link.href} aria-current={current === link.page ? 'page' : undefined}>{link.label}</a>)}
    </nav>
    <div className="la-sidebar-note">Dashboard shows your existing runs. Set up modernization prepares a new project.</div>
  </aside>;
}
