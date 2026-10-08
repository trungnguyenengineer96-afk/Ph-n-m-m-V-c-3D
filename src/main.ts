import './styles.css';
import { ICONS } from './ui/icons';
import { App } from './app/App';

// Fill static icon placeholders in index.html.
document.querySelectorAll<HTMLElement>('.ico[data-icon]').forEach((el) => {
  el.innerHTML = ICONS[el.dataset.icon!] ?? '';
});

const app = new App();

// Desktop app (Electron): files opened by double-click / "Open with" arrive here.
interface DesktopBridge {
  onOpenFiles(cb: (files: { name: string; data: ArrayBuffer; lastModified: number }[]) => void): void;
}
const desktop = (window as unknown as { cadDesktop?: DesktopBridge }).cadDesktop;
desktop?.onOpenFiles((files) => app.openFiles(files.map((f) => new File([f.data], f.name, { lastModified: f.lastModified }))));
if (desktop) document.body.classList.add('desktop');
// Exposed for debugging from the browser console.
(window as unknown as { cadApp: App }).cadApp = app;
