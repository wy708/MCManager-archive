  initCaveLayers() {
    this.netherHeight = 64;
    const wrapper = document.createElement('label');
    wrapper.id = 'netherLayers';
    wrapper.style.cssText = 'position:absolute;top:116px;left:16px;z-index:1000;background:#1b1126;color:#ead9fa;padding:10px;border:1px solid #713b93;border-radius:9px;font:14px sans-serif;display:none';
    wrapper.textContent = mcmanagerMapText('地狱洞穴层 ', 'Nether cave layer ');
    const select = document.createElement('select');
    select.setAttribute('aria-label', mcmanagerMapText('地狱洞穴高度', 'Nether cave height'));
    select.style.cssText = 'background:#302039;color:#fff;border:1px solid #9957bd;padding:5px';
    for (const [value, text] of [[32,mcmanagerMapText('下层 · Y32','Lower · Y32')],[64,mcmanagerMapText('中层 · Y64','Middle · Y64')],[96,mcmanagerMapText('上层 · Y96','Upper · Y96')]]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text; option.selected = value === 64;
      select.append(option);
    }
    wrapper.append(select);
    wrapper.title = mcmanagerMapText('显示与所选高度空腔连通的地面；空白表示无对应洞穴或尚未采集。', 'Shows the floor connected to cavities at this height. Blank means no matching cave or no observation yet.');
    document.body.append(wrapper);
    select.addEventListener('change', () => {
      this.netherHeight = Number(select.value);
      this.map.removeLayer(this.currentTileLayer);
      this.initTileLayer();
    });
    this.netherLayerControl = wrapper;
  }
