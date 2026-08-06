const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function renderOverlaySheet({ id, title, body, size = 'half', className = '' }) {
  const expanded = size === 'full';
  return `
    <div class="overlay-sheet-backdrop" data-overlay-backdrop="${id}">
      <section
        class="overlay-sheet overlay-sheet-${size} ${className}"
        id="${id}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="${id}-title"
        data-overlay-sheet="${id}"
      >
        <button
          class="overlay-sheet-handle"
          type="button"
          data-overlay-size-toggle="${id}"
          aria-label="${expanded ? 'Collapse sheet' : 'Expand sheet'}"
          aria-expanded="${expanded}"
        ><span aria-hidden="true"></span></button>
        <header class="overlay-sheet-header">
          <h2 class="overlay-sheet-title" id="${id}-title">${title}</h2>
          <div class="overlay-sheet-header-actions">
            <button class="overlay-sheet-size" type="button" data-overlay-size-toggle="${id}">
              ${expanded ? 'Collapse' : 'Expand'}
            </button>
            <button class="overlay-sheet-close" type="button" data-overlay-close="${id}" aria-label="Close ${title}">&times;</button>
          </div>
        </header>
        <div class="overlay-sheet-content">${body}</div>
      </section>
    </div>
  `;
}

export function trapOverlayFocus(event, overlay, close) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = [...overlay.querySelectorAll(FOCUSABLE_SELECTOR)];
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function getSheetDragAction(startY, endY, currentSize) {
  const distance = endY - startY;
  if (distance <= -56 && currentSize === 'half') return 'expand';
  if (distance >= 96 && currentSize === 'half') return 'dismiss';
  if (distance >= 56 && currentSize === 'full') return 'collapse';
  return 'none';
}

