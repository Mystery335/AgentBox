import WorkspaceSidebar from './WorkspaceSidebar';
import NewModernization from './NewModernization';
import { useConnectionStatus } from './stdb';
import './Workspace.css';
import './LiveAgentActivity.css';

export default function LiveNewModernization() {
  const { isActive } = useConnectionStatus();
  return <div className="la-shell"><WorkspaceSidebar current={'new'}/><main className="la-main nm-main">
    <header><p className="eyebrow">WORKSPACE / NEW MODERNIZATION</p><span className={isActive ? 'la-connected' : 'la-disconnected'}>{isActive ? '● Database connected' : '○ Connecting to database'}</span></header>
    <NewModernization />
  </main></div>;
}
