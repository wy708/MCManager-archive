  initCoordinateJump() {
    const panel = document.createElement('div');
    panel.id = 'coordinateJump';
    panel.setAttribute('role', 'form');
    panel.setAttribute('aria-label', '地图坐标跳转');
    panel.innerHTML = `<div class="jump-title">跳转到坐标</div>
      <div class="jump-fields">
        <label>X <input name="x" aria-label="目标 X 坐标" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="例如 -600" required></label>
        <label>Z <input name="z" aria-label="目标 Z 坐标" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="例如 40" required></label>
        <button type="button">跳转</button>
      </div>
      <div class="jump-status" role="status" aria-live="polite">在当前维度定位；未绘制的区域会显示空白。</div>`;
    document.body.append(panel);
    const xInput = panel.querySelector('input[name="x"]');
    const zInput = panel.querySelector('input[name="z"]');
    const status = panel.querySelector('.jump-status');
    const center = this.map.getCenter();
    xInput.value = Math.round(center.lng);
    zInput.value = Math.round(-center.lat);
    for (const input of [xInput, zInput]) {
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    }
    const jump = (event) => {
      event.preventDefault();
      const values = [];
      for (const [input, name] of [[xInput, 'X'], [zInput, 'Z']]) {
        const text = input.value.trim();
        const value = Number(text);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(value) || Math.abs(value) > 30000000) {
          input.setAttribute('aria-invalid', 'true');
          status.textContent = `请输入有效的 ${name} 坐标（-30000000 到 30000000，可填负数）。`;
          input.focus();
          return;
        }
        input.removeAttribute('aria-invalid');
        values.push(value);
      }
      const [x, z] = values;
      // The upstream viewer restricts panning to a small initial square. A
      // user-selected destination must not be clamped back into that square.
      this.map.setMaxBounds(null);
      this.map.setView([-z, x], Math.max(this.map.getZoom(), 2), { animate: false });
      this.coordinateTarget?.remove();
      this.coordinateTarget = L.circleMarker([-z, x], {
        radius: 7, color: '#ff71b8', weight: 3, fillColor: '#fff', fillOpacity: 0.65,
      }).addTo(this.map);
      this.coordinateTarget.bindTooltip(`X: ${x}, Z: ${z}`, { direction: 'top' });
      this.elements.coords.textContent = `x: ${x}, z: ${z}`;
      status.textContent = `已定位 X: ${x}，Z: ${z}；空白表示该处尚未绘制。`;
      document.activeElement?.blur();
    };
    // The public map is sandboxed without allow-forms. Handle navigation
    // directly, retaining the existing policy instead of submitting a form.
    panel.querySelector('button').addEventListener('click', jump);
    for (const input of [xInput, zInput]) {
      input.addEventListener('keydown', event => { if (event.key === 'Enter') jump(event); });
    }
  }
