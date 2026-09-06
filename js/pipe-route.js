JS
/**
 * 変曲点座標（折れ線ルート）からの配管モデル生成
 *
 * route.json の points / segments を読み込み、屈曲を含む配管を組み立てる。
 * 既存の直管モデル（PipeModelFactory.createPipe）はそのまま残し、
 * route が与えられたときだけこちらが使われる。
 *
 * 座標変換
 *   JSON  x: 横方向（右が正） / y: 進行方向（前が正） / z: 鉛直（下が負） 単位mm
 *   Three x: 横方向          / y: 鉛直（上が正）      / z: 手前が正         単位m
 *   → three.x =  json.x * 0.001
 *     three.y =  json.z * 0.001   （zは下向き負なので符号そのまま）
 *     three.z = -json.y * 0.001   （前方＝画面奥）
 */
const PipeRoute = {
 
  SCALE: 0.001,
 
  // ─────────────────────────────────────────────
  //  読み込み
  // ─────────────────────────────────────────────
 
  /**
   * route.json を取得する。失敗しても例外は投げず null を返す。
   * @param {string} url
   * @returns {Promise<Object|null>}
   */
  async load(url) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.points || json.points.length < 2) throw new Error('points が不足しています');
      return json;
    } catch (e) {
      console.warn('[PipeRoute] 読込失敗:', url, e.message);
      return null;
    }
  },
 
  /**
   * route を既存の pipeData 形式に変換する。
   * 既存UI（管径・深さ・延長の表示）がそのまま動くようにするためのもの。
   */
  asPipeData(route) {
    const b = this.bounds(route);
    const total = (route.segments || []).reduce((s, x) => s + (x.length || 0), 0);
    const grads = (route.segments || [])
      .filter(s => typeof s.gradient_permille === 'number' && Math.abs(s.gradient_permille) < 100)
      .map(s => s.gradient_permille);
    const avgPermille = grads.length ? grads.reduce((a, c) => a + c, 0) / grads.length : 0;
 
    return {
      id: route.pipeId || 'ROUTE-001',
      type: 'service',
      label: route.title || ('取付管 ' + (route.pipeId || '')),
      diameter: (route.pipe && route.pipe.outerDia_mm) || 166,
      length: Math.round(total),
      depth: Math.round(b.maxDepth_mm),
      slope: Number((Math.abs(avgPermille) / 10).toFixed(2)), // ‰ → %
      material: (route.pipe && route.pipe.spec) || 'VU150',
      color: 0x4fc3f7,
      route: route,
    };
  },
 
  /**
   * 外形範囲（mm）
   */
  bounds(route) {
    const xs = route.points.map(p => p.x);
    const ys = route.points.map(p => p.y);
    const zs = route.points.map(p => p.z);
    return {
      maxDepth_mm: Math.abs(Math.min(...zs)),
      spanX_mm: Math.max(...xs) - Math.min(...xs),
      spanY_mm: Math.max(...ys) - Math.min(...ys),
      spanZ_mm: Math.max(...zs) - Math.min(...zs),
    };
  },
 
  /**
   * JSONの1点を Three.js のベクトルへ
   */
  toVec(p) {
    const s = this.SCALE;
    return new THREE.Vector3(p.x * s, p.z * s, -p.y * s);
  },
 
  // ─────────────────────────────────────────────
  //  モデル生成
  // ─────────────────────────────────────────────
 
  /**
   * ルート全体のモデルを組み立てる
   * @param {Object} route
   * @param {Object} options - { opacity, showLabels, showCenterline, showDepth }
   * @returns {THREE.Group}
   */
  build(route, options = {}) {
    const opacity        = options.opacity        != null ? options.opacity        : 0.62;
    const showLabels     = options.showLabels     !== false;
    const showCenterline = options.showCenterline !== false;
    const showDepth      = options.showDepth      !== false;
 
    const group = new THREE.Group();
    group.name = 'pipe-route';
    group.userData = { route };
 
    const pts = route.points.map(p => this.toVec(p));
    const radius = ((route.pipe && route.pipe.outerDia_mm) || 166) * this.SCALE / 2;
    const color = 0x4fc3f7;
 
    // ── 管本体 ──────────────────────────────
    const pipeMat = new THREE.MeshPhongMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
 
    for (let i = 0; i < pts.length - 1; i++) {
      group.add(this._tube(pts[i], pts[i + 1], radius, pipeMat));
    }
 
    // 継手（屈曲部を球で埋める）
    const jointMat = new THREE.MeshPhongMaterial({
      color: color,
      transparent: true,
      opacity: Math.min(1, opacity + 0.12),
      depthWrite: false,
    });
    for (let i = 1; i < pts.length - 1; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), jointMat);
      s.position.copy(pts[i]);
      group.add(s);
    }
 
    // ── 中心線 ──────────────────────────────
    if (showCenterline) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
      );
      line.renderOrder = 2;
      group.add(line);
    }
 
    // ── 変曲点マーカー ───────────────────────
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0xffee58 });
    pts.forEach((v, i) => {
      const n = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.28, 12, 10), nodeMat);
      n.position.copy(v);
      group.add(n);
 
      if (showLabels && typeof PipeModelFactory !== 'undefined') {
        const label = PipeModelFactory.createTextSprite(route.points[i].label, 0xffee58);
        label.position.copy(v).add(new THREE.Vector3(0, radius + 0.09, 0));
        label.scale.set(0.22, 0.11, 1);
        group.add(label);
      }
    });
 
    // ── 区間の勾配ラベル ─────────────────────
    if (showLabels && typeof PipeModelFactory !== 'undefined' && route.segments) {
      route.segments.forEach((seg, i) => {
        if (i + 1 >= pts.length) return;
        if (typeof seg.gradient_permille !== 'number') return;
 
        // 立下り（急勾配）は角度で、通常区間は‰で表示
        const steep = Math.abs(seg.gradient_permille) >= 100;
        const text = steep
          ? `${seg.inclination_deg.toFixed(1)}°`
          : `${seg.gradient_permille.toFixed(1)}‰`;
 
        const mid = new THREE.Vector3().addVectors(pts[i], pts[i + 1]).multiplyScalar(0.5);
        const sprite = PipeModelFactory.createTextSprite(text, steep ? 0xff8a65 : 0x81c784);
        sprite.position.copy(mid).add(new THREE.Vector3(0, -radius - 0.08, 0));
        sprite.scale.set(0.3, 0.15, 1);
        group.add(sprite);
      });
    }
 
    // ── 深さ寸法線（起点から最深部まで）───────
    if (showDepth) {
      const b = this.bounds(route);
      const depthM = b.maxDepth_mm * this.SCALE;
      const x = pts[0].x - 0.22;
      const z = pts[0].z;
      const dimMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
 
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, 0, z),
          new THREE.Vector3(x, -depthM, z),
        ]), dimMat));
 
      [0, -depthM].forEach(y => {
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x - 0.07, y, z),
            new THREE.Vector3(x + 0.07, y, z),
          ]), dimMat));
      });
 
      if (showLabels && typeof PipeModelFactory !== 'undefined') {
        const s = PipeModelFactory.createTextSprite(`深さ ${Math.round(b.maxDepth_mm)}mm`, 0xffff00);
        s.position.set(x - 0.24, -depthM / 2, z);
        s.scale.set(0.44, 0.22, 1);
        group.add(s);
      }
    }
 
    // ── 地表面リング（起点の目印）────────────
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.1, radius * 1.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pts[0].x, 0.002, pts[0].z);
    group.add(ring);
 
    return group;
  },
 
  /**
   * 2点間を結ぶ円筒を作る
   */
  _tube(a, b, radius, material) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-6) return new THREE.Group();
 
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, len, 28, 1, false),
      material
    );
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize()
    );
    return mesh;
  },
};
 
