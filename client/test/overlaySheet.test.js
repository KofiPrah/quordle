import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSheetDragAction,
  renderOverlaySheet,
  trapOverlayFocus,
} from '../src/overlaySheet.js';

test('sheet drag thresholds expand, collapse, and dismiss predictably', () => {
  assert.equal(getSheetDragAction(200, 120, 'half'), 'expand');
  assert.equal(getSheetDragAction(100, 210, 'half'), 'dismiss');
  assert.equal(getSheetDragAction(100, 170, 'full'), 'collapse');
  assert.equal(getSheetDragAction(100, 130, 'half'), 'none');
});

test('overlay markup exposes an accessible dialog and explicit size control', () => {
  const html = renderOverlaySheet({ id: 'dictionary-sheet', title: 'Dictionary', body: '<p>Body</p>' });
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /data-overlay-size-toggle="dictionary-sheet"/);
  assert.match(html, /data-overlay-close="dictionary-sheet"/);
});

test('focus trapping wraps both ends of the dialog', () => {
  const previousDocument = globalThis.document;
  let focused = null;
  const first = { focus: () => { focused = 'first'; } };
  const last = { focus: () => { focused = 'last'; } };
  const overlay = { querySelectorAll: () => [first, last] };
  const event = { key: 'Tab', shiftKey: false, preventDefault() {} };

  try {
    globalThis.document = { activeElement: last };
    trapOverlayFocus(event, overlay, () => {});
    assert.equal(focused, 'first');

    globalThis.document.activeElement = first;
    event.shiftKey = true;
    trapOverlayFocus(event, overlay, () => {});
    assert.equal(focused, 'last');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('focus trapping skips controls hidden by responsive sheet styles', () => {
  const previousDocument = globalThis.document;
  let focused = null;
  const hiddenHandle = { getClientRects: () => [], focus: () => { focused = 'hidden'; } };
  const firstVisible = { getClientRects: () => [{}], focus: () => { focused = 'first-visible'; } };
  const lastVisible = { getClientRects: () => [{}], focus: () => { focused = 'last-visible'; } };
  const overlay = { querySelectorAll: () => [hiddenHandle, firstVisible, lastVisible] };

  try {
    globalThis.document = { activeElement: lastVisible };
    trapOverlayFocus({ key: 'Tab', shiftKey: false, preventDefault() {} }, overlay, () => {});
    assert.equal(focused, 'first-visible');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('Escape delegates overlay dismissal and prevents gameplay handling', () => {
  let closed = false;
  let prevented = false;
  trapOverlayFocus(
    { key: 'Escape', preventDefault: () => { prevented = true; } },
    { querySelectorAll: () => [] },
    () => { closed = true; },
  );
  assert.equal(prevented, true);
  assert.equal(closed, true);
});
