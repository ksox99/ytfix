const api = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULTS = { sortEnabled: true, preloadPages: 3, hideShelves: true };

(async () => {
  const s = await api.storage.local.get(DEFAULTS);
  const sort = document.getElementById('sortEnabled');
  const pages = document.getElementById('preloadPages');
  const shelves = document.getElementById('hideShelves');
  sort.checked = s.sortEnabled;
  pages.value = s.preloadPages;
  shelves.checked = s.hideShelves;

  sort.addEventListener('change', () => api.storage.local.set({ sortEnabled: sort.checked }));
  shelves.addEventListener('change', () => api.storage.local.set({ hideShelves: shelves.checked }));
  pages.addEventListener('change', () => {
    const n = Math.max(0, Math.min(20, parseInt(pages.value, 10) || 0));
    pages.value = n;
    api.storage.local.set({ preloadPages: n });
  });
})();
