const drivers = new WeakMap();

export function inputDriver(bot) {
  if (drivers.has(bot)) return drivers.get(bot);
  const position = { ...bot.startGameData.player_position }, changes = [];
  let tick = 0n, teleported = true, closed = false, paused = false, heldFlags = [], grounded = false, pitch=0, yaw=0;
  function input(blockActions, itemStackRequest, transaction, options = {}) {
    if (closed) return;
    const movement = options.moveVector ?? (heldFlags.includes('sprinting') ? {x:0,z:1} : {x:0,z:0});
    const moving = heldFlags.includes('sprinting') && !options.position && !teleported;
    if (moving) position.z += 0.28;
    bot.queue('player_auth_input', { pitch, yaw, head_yaw: yaw, position: {...(options.position ?? position)}, move_vector: {...movement},
      input_data: ['received_server_data', ...heldFlags, ...(grounded ? ['vertical_collision'] : []), ...(options.inputData ?? []), ...(teleported ? ['handled_teleport'] : []), ...(blockActions ? ['block_action'] : []), ...(itemStackRequest ? ['item_stack_request'] : []), ...(transaction ? ['item_interact'] : [])],
      input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair', interact_rotation: { x: pitch, z: yaw }, tick: ++tick,
      delta: options.delta ?? { x: 0, y: 0, z: moving ? 0.28 : 0 }, block_action: blockActions, item_stack_request: itemStackRequest, transaction,
      analogue_move_vector: movement, camera_orientation: { x: -Math.sin(yaw*Math.PI/180)*Math.cos(pitch*Math.PI/180), y: -Math.sin(pitch*Math.PI/180), z: Math.cos(yaw*Math.PI/180)*Math.cos(pitch*Math.PI/180) }, raw_move_vector: movement });
    teleported = false;
  }
  bot.on('move_player', packet => { if (String(packet.runtime_id) === String(bot.entityId)) { Object.assign(position, packet.position); if (['reset','teleport',1,2].includes(packet.mode)) teleported = true; } });
  bot.on('change_dimension', packet => {
    changes.push({ ...packet, receivedAt: Date.now() }); Object.assign(position, packet.position); teleported = true;
    const block = { x: 0, y: 0, z: 0 };
    bot.queue('player_action', { runtime_entity_id: bot.entityId, action: 'dimension_change_ack', position: block, result_position: block, face: 0 });
    bot.queue('serverbound_loading_screen', { type: 2, loading_screen_id: packet.loading_screen_id });
  });
  const timer = setInterval(() => { if (!paused) input(); }, 50); timer.unref();
  const close = () => { closed = true; clearInterval(timer); };
  bot.once('close', close); bot.once('disconnect', close);
  const driver = { position, changes, input, setPaused: value => { paused = value; }, setFlags: flags => { heldFlags = [...flags]; }, setGrounded: value => { grounded = value; },setView:(nextPitch,nextYaw=0)=>{if(!Number.isFinite(nextPitch)||!Number.isFinite(nextYaw))throw new Error('Invalid QA view');pitch=nextPitch;yaw=nextYaw;} }; drivers.set(bot, driver); return driver;
}
