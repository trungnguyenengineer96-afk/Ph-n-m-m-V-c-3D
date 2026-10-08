import './styles.css';
import { ICONS } from './ui/icons';
import { App } from './app/App';

// Fill static icon placeholders in index.html.
document.querySelectorAll<HTMLElement>('.ico[data-icon]').forEach((el) => {
  el.innerHTML = ICONS[el.dataset.icon!] ?? '';
});

const app = new App();
// Exposed for debugging from the browser console.
(window as unknown as { cadApp: App }).cadApp = app;
