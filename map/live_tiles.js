  async function refreshVisibleTiles() {
    if (this.refreshingTiles) return;
    const layer = this.currentTileLayer;
    const container = layer?.getContainer();
    if (!container) return;
    this.refreshingTiles = true;
    try {
      await Promise.all([...container.querySelectorAll('img.leaflet-tile')].map(async (tile) => {
        let objectUrl;
        try {
          const source = tile.dataset.mapSource || tile.src;
          if (!source || source.startsWith('blob:') || source.startsWith('data:')) return;
          const url = new URL(source);
          url.searchParams.set('v', Date.now());
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) return;
          const blob = await response.blob();
          const digest = globalThis.crypto?.subtle
            ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('')
            : '';
          if (digest && digest === tile.dataset.mapDigest) return;
          objectUrl = URL.createObjectURL(blob);
          const next = new Image();
          next.src = objectUrl;
          await next.decode();
          if (layer !== this.currentTileLayer || !tile.isConnected) return;
          const previous = tile.dataset.mapBlob;
          tile.dataset.mapSource = source;
          tile.dataset.mapDigest = digest;
          tile.dataset.mapBlob = objectUrl;
          // This tile has already completed its initial Leaflet load. Avoid
          // restarting Leaflet's fade animation when replacing decoded pixels.
          L.DomEvent.off(tile, 'load');
          L.DomUtil.addClass(tile, 'leaflet-tile-loaded');
          tile.style.opacity = '1';
          tile.src = objectUrl;
          objectUrl = null;
          if (previous) requestAnimationFrame(() => URL.revokeObjectURL(previous));
        } catch (_) {
          // Keep the last visible pixels if a request or decode fails.
        } finally {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
      }));
    } finally {
      this.refreshingTiles = false;
    }
  }
