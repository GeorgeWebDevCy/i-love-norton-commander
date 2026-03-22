import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

type PanelId = "left" | "right";
type SortKey = "name" | "ext" | "size" | "date";
type StatusTone = "info" | "success" | "error" | "busy";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
}

interface DirectoryContents {
  entries: FileEntry[];
  path: string;
}

interface ViewEntry extends FileEntry {
  ext: string;
  isParent?: boolean;
}

interface PanelState {
  path: string;
  entries: ViewEntry[];
  visibleEntries: ViewEntry[];
  selectedIndex: number;
  sortKey: SortKey;
  sortDirection: 1 | -1;
  loading: boolean;
}

interface PanelRefs {
  root: HTMLElement;
  driveSelect: HTMLSelectElement;
  pathInput: HTMLInputElement;
  fileList: HTMLElement;
  itemCount: HTMLElement;
  selectedInfo: HTMLElement;
  sortButtons: HTMLButtonElement[];
}

interface ModalButton {
  label: string;
  value: string;
  variant?: "primary" | "danger" | "ghost";
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const state: {
  activePanel: PanelId;
  drives: string[];
  filter: string;
  modalOpen: boolean;
  panels: Record<PanelId, PanelState>;
} = {
  activePanel: "left",
  drives: [],
  filter: "",
  modalOpen: false,
  panels: {
    left: createPanelState(),
    right: createPanelState(),
  },
};

const panelRefs: Record<PanelId, PanelRefs> = {
  left: createPanelRefs("left"),
  right: createPanelRefs("right"),
};

const filterInput = required<HTMLInputElement>("#filter-input");
const statusBar = required<HTMLElement>("#status-bar");
const menuItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu-item"));
const commandButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".command-button"),
);

const modalOverlay = required<HTMLElement>("#modal-overlay");
const modalHeader = required<HTMLElement>("#modal-header");
const modalContent = required<HTMLElement>("#modal-content");
const modalButtons = required<HTMLElement>("#modal-buttons");

let resolveModal: ((value: string) => void) | null = null;

void bootstrap();

function createPanelState(): PanelState {
  return {
    path: "",
    entries: [],
    visibleEntries: [],
    selectedIndex: 0,
    sortKey: "name",
    sortDirection: 1,
    loading: false,
  };
}

function createPanelRefs(id: PanelId): PanelRefs {
  const root = required<HTMLElement>(`#${id}-panel`);
  return {
    root,
    driveSelect: required<HTMLSelectElement>(`#${id}-drive-select`),
    pathInput: required<HTMLInputElement>(`#${id}-path`),
    fileList: required<HTMLElement>(`#${id}-file-list`),
    itemCount: required<HTMLElement>(`#${id}-item-count`),
    selectedInfo: required<HTMLElement>(`#${id}-selected-info`),
    sortButtons: Array.from(root.querySelectorAll<HTMLButtonElement>(".sort-button")),
  };
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

async function bootstrap(): Promise<void> {
  try {
    bindEvents();
    await initializePanels();
    renderAll();
    setStatus(
      "Commander ready. Use Enter to open, Tab to swap panes, and F5-F9 for actions.",
      "info",
    );
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error), "error");
  }
}

function bindEvents(): void {
  filterInput.addEventListener("input", () => {
    const leftName = getSelectedEntry("left")?.name;
    const rightName = getSelectedEntry("right")?.name;
    state.filter = filterInput.value.trim();
    rebuildVisibleEntries("left", leftName);
    rebuildVisibleEntries("right", rightName);
    renderAll();
  });

  modalOverlay.addEventListener("click", (event) => {
    if (event.target === modalOverlay) {
      closeModal("cancel");
    }
  });

  window.addEventListener("keydown", (event) => {
    if (state.modalOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal("cancel");
      }
      return;
    }

    void handleShortcut(event);
  });

  for (const panelId of panelIds()) {
    const refs = panelRefs[panelId];

    refs.root.addEventListener("pointerdown", () => {
      setActivePanel(panelId);
    });

    refs.driveSelect.addEventListener("change", () => {
      void loadPanel(panelId, refs.driveSelect.value);
    });

    refs.fileList.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (!row) {
        return;
      }

      const index = Number(row.dataset.index);
      if (Number.isNaN(index)) {
        return;
      }

      setActivePanel(panelId);
      state.panels[panelId].selectedIndex = index;
      renderAll();
    });

    refs.fileList.addEventListener("dblclick", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (!row) {
        return;
      }

      const index = Number(row.dataset.index);
      if (Number.isNaN(index)) {
        return;
      }

      setActivePanel(panelId);
      state.panels[panelId].selectedIndex = index;
      renderAll();
      void openSelection(panelId);
    });

    for (const button of refs.sortButtons) {
      button.addEventListener("click", () => {
        const sortKey = button.dataset.sort as SortKey | undefined;
        if (!sortKey) {
          return;
        }

        toggleSort(panelId, sortKey);
        renderAll();
      });
    }
  }

  for (const button of commandButtons) {
    button.addEventListener("click", () => {
      void runCommand(button.dataset.command ?? "");
    });
  }

  for (const button of menuItems) {
    button.addEventListener("click", () => {
      void runMenuAction(button.dataset.menu ?? "");
    });
  }
}

async function initializePanels(): Promise<void> {
  const drives = await invoke<string[]>("get_drives");
  state.drives = drives.length > 0 ? drives : ["/"];
  populateDriveSelectors();

  const leftPath = state.drives[0];
  const rightPath = state.drives[1] ?? leftPath;

  await Promise.all([loadPanel("left", leftPath), loadPanel("right", rightPath)]);
}

function populateDriveSelectors(): void {
  const optionMarkup = state.drives
    .map((drive) => `<option value="${escapeHtml(drive)}">${escapeHtml(drive)}</option>`)
    .join("");

  for (const panelId of panelIds()) {
    panelRefs[panelId].driveSelect.innerHTML = optionMarkup;
  }
}

async function loadPanel(
  panelId: PanelId,
  nextPath: string,
  preserveName?: string,
): Promise<void> {
  const panel = state.panels[panelId];
  panel.loading = true;
  setStatus(`Loading ${nextPath}...`, "busy");
  renderPanel(panelId);

  try {
    const result = await invoke<DirectoryContents>("read_directory", { path: nextPath });
    panel.path = result.path;
    panel.entries = result.entries.map((entry) => ({
      ...entry,
      ext: entry.is_dir ? "" : getExtension(entry.name),
    }));
    rebuildVisibleEntries(panelId, preserveName);
    updateDriveSelect(panelId);
    setStatus(`${panel.path} loaded.`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  } finally {
    panel.loading = false;
    renderAll();
  }
}

function rebuildVisibleEntries(panelId: PanelId, preserveName?: string): void {
  const panel = state.panels[panelId];
  const fallbackSelection = panel.visibleEntries[panel.selectedIndex]?.name;
  const selectedName = preserveName ?? fallbackSelection;
  const filtered = panel.entries.filter((entry) => matchesFilter(entry.name, state.filter));
  const sorted = sortEntries(filtered, panel.sortKey, panel.sortDirection);
  const parentPath = getParentPath(panel.path);

  panel.visibleEntries = parentPath
    ? [
        {
          name: "..",
          path: parentPath,
          is_dir: true,
          size: 0,
          modified: null,
          ext: "",
          isParent: true,
        },
        ...sorted,
      ]
    : sorted;

  const nextIndex = selectedName
    ? panel.visibleEntries.findIndex((entry) => entry.name === selectedName)
    : -1;

  panel.selectedIndex = clamp(
    nextIndex >= 0 ? nextIndex : 0,
    0,
    Math.max(panel.visibleEntries.length - 1, 0),
  );
}

function sortEntries(
  entries: ViewEntry[],
  sortKey: SortKey,
  direction: 1 | -1,
): ViewEntry[] {
  return [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }

    let comparison = 0;
    switch (sortKey) {
      case "ext":
        comparison = left.ext.localeCompare(right.ext, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        break;
      case "size":
        comparison = left.size - right.size;
        break;
      case "date":
        comparison = (left.modified ?? 0) - (right.modified ?? 0);
        break;
      case "name":
      default:
        comparison = left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        break;
    }

    if (comparison === 0) {
      comparison = left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }

    return comparison * direction;
  });
}

function toggleSort(panelId: PanelId, sortKey: SortKey): void {
  const panel = state.panels[panelId];
  if (panel.sortKey === sortKey) {
    panel.sortDirection = panel.sortDirection === 1 ? -1 : 1;
  } else {
    panel.sortKey = sortKey;
    panel.sortDirection = 1;
  }

  rebuildVisibleEntries(panelId);
}

function renderAll(): void {
  renderPanel("left");
  renderPanel("right");
  renderMenuState();
  renderCommandState();
}

function renderPanel(panelId: PanelId): void {
  const panel = state.panels[panelId];
  const refs = panelRefs[panelId];
  const selectedEntry = getSelectedEntry(panelId);

  refs.root.classList.toggle("is-active", state.activePanel === panelId);
  refs.pathInput.value = panel.path;

  for (const button of refs.sortButtons) {
    const sortKey = button.dataset.sort as SortKey | undefined;
    const active = sortKey === panel.sortKey;
    button.classList.toggle("is-active", active);
    button.dataset.direction = active && panel.sortDirection === -1 ? "desc" : "asc";
  }

  if (panel.loading) {
    refs.fileList.innerHTML = '<div class="empty-state">Scanning directory...</div>';
  } else if (panel.visibleEntries.length === 0) {
    refs.fileList.innerHTML =
      '<div class="empty-state">No items match the current filter.</div>';
  } else {
    refs.fileList.innerHTML = panel.visibleEntries
      .map((entry, index) => renderEntry(entry, index, index === panel.selectedIndex))
      .join("");
  }

  refs.itemCount.textContent = state.filter
    ? `${panel.visibleEntries.length} shown / ${panel.entries.length} total`
    : `${panel.entries.length} item${panel.entries.length === 1 ? "" : "s"}`;
  refs.selectedInfo.textContent = describeSelection(selectedEntry);
}

function renderEntry(entry: ViewEntry, index: number, selected: boolean): string {
  const rowClass = [
    "file-row",
    selected ? "is-selected" : "",
    entry.is_dir ? "is-directory" : "is-file",
    entry.isParent ? "is-parent" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const name = entry.isParent ? "..  Parent Directory" : entry.name;
  const size = entry.isParent ? "UP" : entry.is_dir ? "DIR" : formatSize(entry.size);
  const ext = entry.isParent ? "" : entry.ext || "—";

  return `
    <button type="button" class="${rowClass}" data-index="${index}">
      <span class="col-name">${escapeHtml(name)}</span>
      <span class="col-ext">${escapeHtml(ext)}</span>
      <span class="col-size">${escapeHtml(size)}</span>
      <span class="col-date">${escapeHtml(formatDate(entry.modified))}</span>
    </button>
  `;
}

function describeSelection(entry: ViewEntry | undefined): string {
  if (!entry) {
    return "Nothing selected";
  }

  if (entry.isParent) {
    return "Jump to the parent directory";
  }

  if (entry.is_dir) {
    return `Directory: ${entry.name}`;
  }

  return `${entry.name} • ${formatSize(entry.size)}`;
}

function renderMenuState(): void {
  for (const button of menuItems) {
    const menu = button.dataset.menu;
    button.classList.toggle(
      "is-active",
      (menu === "left" && state.activePanel === "left") ||
        (menu === "right" && state.activePanel === "right"),
    );
  }
}

function renderCommandState(): void {
  const selected = getSelectedEntry(state.activePanel);
  const actionable = Boolean(selected && !selected.isParent);

  for (const button of commandButtons) {
    const command = button.dataset.command;
    button.disabled = command !== "new-folder" && !actionable;
  }
}

function setActivePanel(panelId: PanelId): void {
  state.activePanel = panelId;
  renderAll();
}

function getSelectedEntry(panelId: PanelId): ViewEntry | undefined {
  return state.panels[panelId].visibleEntries[state.panels[panelId].selectedIndex];
}

function panelIds(): PanelId[] {
  return ["left", "right"];
}

function otherPanel(panelId: PanelId): PanelId {
  return panelId === "left" ? "right" : "left";
}

async function handleShortcut(event: KeyboardEvent): Promise<void> {
  switch (event.key) {
    case "Tab":
      event.preventDefault();
      setActivePanel(otherPanel(state.activePanel));
      return;
    case "ArrowUp":
      event.preventDefault();
      moveSelection(state.activePanel, -1);
      return;
    case "ArrowDown":
      event.preventDefault();
      moveSelection(state.activePanel, 1);
      return;
    case "Enter":
      event.preventDefault();
      await openSelection(state.activePanel);
      return;
    case "Backspace":
      event.preventDefault();
      await openParent(state.activePanel);
      return;
    case "F1":
      event.preventDefault();
      await openInstallCenter();
      return;
    case "F2":
      event.preventDefault();
      await openToolsCenter();
      return;
    case "F5":
      event.preventDefault();
      await copySelection();
      return;
    case "F6":
      event.preventDefault();
      await moveSelectionToOtherPanel();
      return;
    case "F7":
      event.preventDefault();
      await createFolder();
      return;
    case "F8":
      event.preventDefault();
      await deleteSelection();
      return;
    case "F9":
      event.preventDefault();
      await renameSelection();
      return;
    default:
      break;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    await refreshBothPanels();
  }
}

function moveSelection(panelId: PanelId, delta: number): void {
  const panel = state.panels[panelId];
  if (panel.visibleEntries.length === 0) {
    return;
  }

  panel.selectedIndex = clamp(
    panel.selectedIndex + delta,
    0,
    panel.visibleEntries.length - 1,
  );
  renderAll();
}

async function runMenuAction(menu: string): Promise<void> {
  switch (menu) {
    case "install":
      await openInstallCenter();
      break;
    case "tools":
      await openToolsCenter();
      break;
    case "left":
      setActivePanel("left");
      break;
    case "right":
      setActivePanel("right");
      break;
    case "file":
      await openFileMenu();
      break;
    case "commands":
      await openShortcuts();
      break;
    case "options":
      await openToolsCenter();
      break;
    default:
      break;
  }
}

async function runCommand(command: string): Promise<void> {
  switch (command) {
    case "copy":
      await copySelection();
      break;
    case "move":
      await moveSelectionToOtherPanel();
      break;
    case "new-folder":
      await createFolder();
      break;
    case "delete":
      await deleteSelection();
      break;
    case "rename":
      await renameSelection();
      break;
    default:
      break;
  }
}

async function openSelection(panelId: PanelId): Promise<void> {
  const entry = getSelectedEntry(panelId);
  if (!entry) {
    return;
  }

  if (entry.isParent || entry.is_dir) {
    await loadPanel(panelId, entry.path);
    return;
  }

  try {
    await openPath(entry.path);
    setStatus(`Opened ${entry.name}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function openParent(panelId: PanelId): Promise<void> {
  const parentPath = getParentPath(state.panels[panelId].path);
  if (!parentPath) {
    return;
  }

  await loadPanel(panelId, parentPath);
}

async function copySelection(): Promise<void> {
  const entry = getActionableSelection();
  if (!entry) {
    return;
  }

  const destination = window.prompt(
    `Copy ${entry.name} to:`,
    joinPath(state.panels[otherPanel(state.activePanel)].path, entry.name),
  );
  if (!destination?.trim()) {
    return;
  }

  try {
    await invoke("copy_file", { source: entry.path, destination: destination.trim() });
    await refreshBothPanels(entry.name);
    setStatus(`Copied ${entry.name}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function moveSelectionToOtherPanel(): Promise<void> {
  const entry = getActionableSelection();
  if (!entry) {
    return;
  }

  const destination = window.prompt(
    `Move ${entry.name} to:`,
    joinPath(state.panels[otherPanel(state.activePanel)].path, entry.name),
  );
  if (!destination?.trim()) {
    return;
  }

  try {
    await invoke("move_file", { source: entry.path, destination: destination.trim() });
    await refreshBothPanels();
    setStatus(`Moved ${entry.name}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function renameSelection(): Promise<void> {
  const entry = getActionableSelection();
  if (!entry) {
    return;
  }

  const nextName = window.prompt(`Rename ${entry.name} to:`, entry.name)?.trim();
  if (!nextName || nextName === entry.name) {
    return;
  }

  try {
    await invoke("rename_file", { oldPath: entry.path, newName: nextName });
    await refreshPanel(state.activePanel, nextName);
    setStatus(`Renamed to ${nextName}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function createFolder(): Promise<void> {
  const folderName = window.prompt("Create folder:", "New Folder")?.trim();
  if (!folderName) {
    return;
  }

  try {
    await invoke("create_directory", {
      path: joinPath(state.panels[state.activePanel].path, folderName),
    });
    await refreshPanel(state.activePanel, folderName);
    setStatus(`Created ${folderName}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function deleteSelection(): Promise<void> {
  const entry = getActionableSelection();
  if (!entry) {
    return;
  }

  const confirmed = window.confirm(
    entry.is_dir
      ? `Delete ${entry.name} and everything inside it?`
      : `Delete ${entry.name}?`,
  );
  if (!confirmed) {
    return;
  }

  try {
    await invoke("delete_file", { path: entry.path });
    await refreshPanel(state.activePanel);
    setStatus(`Deleted ${entry.name}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function refreshPanel(panelId: PanelId, preserveName?: string): Promise<void> {
  await loadPanel(panelId, state.panels[panelId].path, preserveName);
}

async function refreshBothPanels(preserveName?: string): Promise<void> {
  await Promise.all([
    refreshPanel("left", state.activePanel === "left" ? preserveName : undefined),
    refreshPanel("right", state.activePanel === "right" ? preserveName : undefined),
  ]);
}

async function openFileMenu(): Promise<void> {
  const choice = await showModal({
    title: "File Menu",
    html: `
      <p class="modal-copy">Choose a command for the current selection.</p>
      <div class="modal-grid">
        <button type="button" class="modal-action" data-modal-action="copy">Copy to other pane</button>
        <button type="button" class="modal-action" data-modal-action="move">Move to other pane</button>
        <button type="button" class="modal-action" data-modal-action="rename">Rename selected</button>
        <button type="button" class="modal-action" data-modal-action="delete">Delete selected</button>
        <button type="button" class="modal-action" data-modal-action="new-folder">Create folder</button>
      </div>
    `,
    buttons: [{ label: "Close", value: "close", variant: "ghost" }],
    onReady: () => bindModalActions(),
  });

  await runCommand(choice);
}

async function openShortcuts(): Promise<void> {
  await showModal({
    title: "Commands",
    html: `
      <div class="shortcut-list">
        <p><strong>Tab</strong> switches the active pane.</p>
        <p><strong>Arrow Up / Down</strong> moves the selection.</p>
        <p><strong>Enter</strong> opens a folder or launches a file.</p>
        <p><strong>Backspace</strong> goes to the parent directory.</p>
        <p><strong>F1</strong> opens install help and <strong>F2</strong> opens tools.</p>
        <p><strong>F5-F9</strong> map to Copy, Move, New Folder, Delete, and Rename.</p>
        <p><strong>Ctrl/Cmd + R</strong> refreshes both panes.</p>
      </div>
    `,
    buttons: [{ label: "Close", value: "close", variant: "primary" }],
  });
}

async function openToolsCenter(): Promise<void> {
  const choice = await showModal({
    title: "Tools",
    html: `
      <p class="modal-copy">Quick utilities for the active pane and selected item.</p>
      <div class="modal-grid">
        <button type="button" class="modal-action" data-modal-action="refresh-both">Refresh both panes</button>
        <button type="button" class="modal-action" data-modal-action="swap-panels">Swap panel locations</button>
        <button type="button" class="modal-action" data-modal-action="copy-path">Copy active path</button>
        <button type="button" class="modal-action" data-modal-action="open-folder">Open active folder</button>
        <button type="button" class="modal-action" data-modal-action="reveal-item">Reveal selected item</button>
        <button type="button" class="modal-action" data-modal-action="install">Open install help</button>
      </div>
    `,
    buttons: [{ label: "Close", value: "close", variant: "ghost" }],
    onReady: () => bindModalActions(),
  });

  switch (choice) {
    case "refresh-both":
      await refreshBothPanels();
      break;
    case "swap-panels":
      await swapPanels();
      break;
    case "copy-path":
      await copyActivePath();
      break;
    case "open-folder":
      await openCurrentFolder();
      break;
    case "reveal-item":
      await revealSelection();
      break;
    case "install":
      await openInstallCenter();
      break;
    default:
      break;
  }
}

async function openInstallCenter(): Promise<void> {
  await showModal({
    title: "Install + Build",
    html: `
      <p class="modal-copy">This project uses Tauri, so the desktop toolchain matters as much as the frontend code.</p>
      <div class="install-checklist">
        <p><strong>1.</strong> Install Node.js and npm.</p>
        <p><strong>2.</strong> Install the Rust toolchain so <code>cargo</code> is available.</p>
        <p><strong>3.</strong> On Windows, install the Visual Studio C++ build tools required by Tauri.</p>
      </div>
      <div class="command-stack">
        <button type="button" class="modal-command" data-copy="npm install">npm install</button>
        <button type="button" class="modal-command" data-copy="npm run tauri dev">npm run tauri dev</button>
        <button type="button" class="modal-command" data-copy="npm run tauri build">npm run tauri build</button>
      </div>
      <p class="modal-copy muted">This shell currently does not have <code>cargo</code> on PATH, so Rust still needs to be installed before native builds can run here.</p>
      <button type="button" class="link-button" data-open-url="https://tauri.app/start/prerequisites/">Open Tauri prerequisites</button>
    `,
    buttons: [{ label: "Close", value: "close", variant: "primary" }],
    onReady: () => {
      for (const button of modalContent.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
        button.addEventListener("click", () => {
          void copyToClipboard(button.dataset.copy ?? "");
        });
      }

      modalContent
        .querySelector<HTMLButtonElement>("[data-open-url]")
        ?.addEventListener("click", () => {
          void openUrl("https://tauri.app/start/prerequisites/");
        });
    },
  });
}

async function swapPanels(): Promise<void> {
  const leftPath = state.panels.left.path;
  const rightPath = state.panels.right.path;
  await Promise.all([loadPanel("left", rightPath), loadPanel("right", leftPath)]);
  setStatus("Swapped panel locations.", "success");
}

async function copyActivePath(): Promise<void> {
  await copyToClipboard(state.panels[state.activePanel].path);
  setStatus("Active path copied to the clipboard.", "success");
}

async function openCurrentFolder(): Promise<void> {
  try {
    await openPath(state.panels[state.activePanel].path);
    setStatus("Opened the active folder in the system shell.", "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function revealSelection(): Promise<void> {
  const entry = getActionableSelection();
  if (!entry) {
    return;
  }

  try {
    await revealItemInDir(entry.path);
    setStatus(`Revealed ${entry.name}`, "success");
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

function getActionableSelection(): ViewEntry | null {
  const entry = getSelectedEntry(state.activePanel);
  if (!entry || entry.isParent) {
    setStatus("Select a file or folder first.", "error");
    return null;
  }

  return entry;
}

async function showModal(options: {
  title: string;
  html: string;
  buttons: ModalButton[];
  onReady?: () => void;
}): Promise<string> {
  if (resolveModal) {
    closeModal("cancel");
  }

  state.modalOpen = true;
  modalHeader.textContent = options.title;
  modalContent.innerHTML = options.html;
  modalButtons.innerHTML = "";

  const promise = new Promise<string>((resolve) => {
    resolveModal = resolve;
  });

  for (const button of options.buttons) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `modal-button ${button.variant ?? "ghost"}`;
    element.textContent = button.label;
    element.addEventListener("click", () => closeModal(button.value));
    modalButtons.append(element);
  }

  modalOverlay.classList.remove("hidden");
  options.onReady?.();
  return promise;
}

function bindModalActions(): void {
  for (const button of modalContent.querySelectorAll<HTMLButtonElement>("[data-modal-action]")) {
    button.addEventListener("click", () => {
      closeModal(button.dataset.modalAction ?? "close");
    });
  }
}

function closeModal(value: string): void {
  modalOverlay.classList.add("hidden");
  modalContent.innerHTML = "";
  modalButtons.innerHTML = "";
  state.modalOpen = false;

  if (resolveModal) {
    const resolver = resolveModal;
    resolveModal = null;
    resolver(value);
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied: ${text}`, "success");
  } catch {
    window.prompt("Copy to clipboard:", text);
    setStatus("Clipboard access fell back to a prompt.", "info");
  }
}

function updateDriveSelect(panelId: PanelId): void {
  const drive = inferDrive(state.panels[panelId].path);
  if (drive) {
    panelRefs[panelId].driveSelect.value = drive;
  }
}

function inferDrive(path: string): string | null {
  const windowsDrive = path.match(/^[A-Za-z]:\\/);
  if (windowsDrive) {
    return windowsDrive[0];
  }

  return path.startsWith("/") ? "/" : null;
}

function joinPath(basePath: string, name: string): string {
  const normalizedBase = stripTrailingSeparators(basePath);
  if (isWindowsRoot(normalizedBase)) {
    return `${normalizedBase}${name}`;
  }

  if (normalizedBase === "/") {
    return `/${name}`;
  }

  const separator = normalizedBase.includes("\\") ? "\\" : "/";
  return `${normalizedBase}${separator}${name}`;
}

function getParentPath(path: string): string | null {
  const normalized = stripTrailingSeparators(path);
  if (normalized === "/" || isWindowsRoot(normalized)) {
    return null;
  }

  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (normalized.includes("\\")) {
    if (parts.length <= 2) {
      return `${parts[0]}\\`;
    }

    parts.pop();
    return parts.join("\\");
  }

  if (parts.length <= 1) {
    return "/";
  }

  parts.pop();
  return `/${parts.join("/")}`;
}

function stripTrailingSeparators(path: string): string {
  if (path === "/") {
    return "/";
  }

  if (isWindowsRoot(path)) {
    return `${path.slice(0, 2)}\\`;
  }

  return path.replace(/[\\/]+$/, "");
}

function isWindowsRoot(path: string): boolean {
  return /^[A-Za-z]:\\?$/.test(path);
}

function getExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts[parts.length - 1] ?? "" : "";
}

function matchesFilter(name: string, rawPattern: string): boolean {
  if (!rawPattern) {
    return true;
  }

  const expression = rawPattern
    .split("")
    .map((character) => {
      if (character === "*") {
        return ".*";
      }
      if (character === "?") {
        return ".";
      }
      return escapeRegex(character);
    })
    .join("");

  return new RegExp(`^${expression}$`, "i").test(name);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) {
    return "—";
  }

  return dateFormatter.format(new Date(timestamp * 1000));
}

function setStatus(message: string, tone: StatusTone): void {
  statusBar.textContent = message;
  statusBar.dataset.tone = tone;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
