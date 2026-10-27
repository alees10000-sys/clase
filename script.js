(function () {
  'use strict';

  /* ---------- Programa que se depura ---------- */
  var SRC = [
    'public class Main {',
    '    public static void main(String[] args) {',
    '        int n = 3;',
    '        int r = factorial(n);',
    '        System.out.println(r);',
    '    }',
    '    static int factorial(int x) {',
    '        if (x <= 1) return 1;',
    '        int p = factorial(x - 1);',
    '        return x * p;',
    '    }',
    '}'
  ];

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(line) {
    var re = /\b(public|class|static|void|if|return)\b|\b(int|String|System)\b|\b(\d+)\b|\b(factorial|println|main)(?=\()/g;
    var out = '', last = 0, m;
    while ((m = re.exec(line)) !== null) {
      out += esc(line.slice(last, m.index));
      var cls = m[1] ? 'k' : m[2] ? 't' : m[3] ? 'n' : 'f';
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(line.slice(last));
  }

  /* ---------- Simulador: crea la «película» de la ejecución ---------- */
  function buildTrace() {
    var trace = [], stack = [], out = [], pending = '';

    function snap(line, note) {
      stack[stack.length - 1].line = line;
      trace.push({
        line: line,
        depth: stack.length,
        out: out.slice(),
        frames: stack.map(function (f) {
          return { name: f.name, sig: f.sig, line: f.line, vars: Object.assign({}, f.vars) };
        }),
        note: (pending ? pending + ' ' : '') + note
      });
      pending = '';
    }

    function fact(x) {
      var me = { name: 'factorial', sig: 'factorial(int x = ' + x + ')', line: 8, vars: { x: x, p: undefined } };
      stack.push(me);
      var res;
      if (x <= 1) {
        snap(8, 'Pregunta: ¿x <= 1? x vale ' + x + ', así que sí. La función va a devolver 1.');
        res = 1;
      } else {
        snap(8, 'Pregunta: ¿x <= 1? x vale ' + x + ', así que no. Sigue en la línea 9.');
        snap(9, 'Va a llamar a factorial(' + (x - 1) + '). Step Into entra en ella. Step Over la ejecuta entera.');
        var p = fact(x - 1);
        me.vars.p = p;
        snap(10, 'p ya vale ' + p + '. Va a devolver x * p = ' + x + ' * ' + p + ' = ' + (x * p) + '.');
        res = x * p;
      }
      stack.pop();
      pending = 'factorial(' + x + ') devolvió ' + res + ' y salió de la pila.';
      return res;
    }

    var main = { name: 'main', sig: 'main(String[] args)', line: 3, vars: { n: undefined, r: undefined } };
    stack.push(main);
    snap(3, 'El programa está parado ANTES de ejecutar esta línea. n aún no tiene valor.');
    main.vars.n = 3;
    snap(4, 'n ya vale 3. Va a llamar a factorial(n).');
    var r = fact(3);
    main.vars.r = r;
    snap(5, 'r ya vale ' + r + '. Va a escribir r en la consola.');
    out.push(String(r));
    stack.pop();
    trace.push({
      line: null, depth: 0, out: out.slice(), frames: [],
      note: pending + ' El programa terminó. La JVM se cierra y el depurador se desconecta.'
    });
    return trace;
  }

  var trace = buildTrace();

  /* ---------- Elementos ---------- */
  function $(id) { return document.getElementById(id); }
  var el = {
    code: $('code'), stack: $('stack'), vars: $('vars').tBodies[0], cons: $('console'),
    note: $('note'), status: $('status'), log: $('log'), packet: $('packet'), wire: $('wire'),
    start: $('b-start'), resume: $('b-resume'), over: $('b-over'), into: $('b-into'),
    out: $('b-out'), auto: $('b-auto'), reset: $('b-reset'), speed: $('speed')
  };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Estado ---------- */
  var DEFAULT_NOTE = 'Pulsa <b>Depurar</b>. Hay dos breakpoints puestos (líneas 4 y 10). Puedes quitarlos o poner más.';
  var idx = -1;                       // -1 = sin iniciar
  var breakpoints = { 4: true, 10: true };
  var autoTimer = null;

  /* ---------- Código en pantalla ---------- */
  var lineEls = [];
  SRC.forEach(function (text, i) {
    var n = i + 1;
    var row = document.createElement('div');
    row.className = 'cl';
    var bp = document.createElement('button');
    bp.className = 'bp';
    bp.type = 'button';
    bp.addEventListener('click', function () { toggleBreakpoint(n); });
    var arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '▶';
    var no = document.createElement('span');
    no.className = 'no';
    no.textContent = n;
    var src = document.createElement('span');
    src.className = 'src';
    src.innerHTML = highlight(text);
    row.appendChild(bp); row.appendChild(arrow); row.appendChild(no); row.appendChild(src);
    el.code.appendChild(row);
    lineEls[n] = row;
  });

  function paintBreakpoints() {
    lineEls.forEach(function (row, n) {
      if (!row) return;
      var on = !!breakpoints[n];
      row.classList.toggle('has-bp', on);
      var b = row.firstChild;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', (on ? 'Quitar' : 'Poner') + ' breakpoint en la línea ' + n);
    });
  }

  /* ---------- Mensajes JDWP y animación del cable ---------- */
  var gen = 0;

  function logMsg(dir, text) {
    var li = document.createElement('li');
    li.className = dir === 'ide' ? 'to-ide' : 'to-jvm';
    li.textContent = (dir === 'ide' ? '◀ JVM → IDE: ' : '▶ IDE → JVM: ') + text;
    el.log.insertBefore(li, el.log.firstChild);
    while (el.log.children.length > 5) el.log.removeChild(el.log.lastChild);
  }

  function fly(text, toJvm) {
    return new Promise(function (resolve) {
      var p = el.packet;
      p.textContent = text;
      p.className = 'packet' + (toJvm ? '' : ' event');
      if (reduceMotion || !p.animate) { resolve(); return; }
      var dist = Math.max(0, el.wire.clientWidth - p.offsetWidth);
      var from = toJvm ? 0 : dist, to = toJvm ? dist : 0;
      var a = p.animate(
        [{ transform: 'translateX(' + from + 'px)', opacity: 1 },
         { transform: 'translateX(' + to + 'px)', opacity: 1 }],
        { duration: 650, easing: 'ease-in-out' }
      );
      a.onfinish = function () { p.style.opacity = 0; resolve(); };
      a.oncancel = resolve;
    });
  }

  function pulse(selector) {
    var n = document.querySelector(selector);
    if (!n || reduceMotion) return;
    n.classList.remove('pulse');
    void n.offsetWidth;
    n.classList.add('pulse');
  }

  // Dos viajes: la orden va a la JVM y el evento vuelve al IDE.
  function conversation(command, event) {
    var my = ++gen;
    logMsg('jvm', command);
    logMsg('ide', event);
    fly(command, true).then(function () {
      if (my !== gen) return;
      pulse('.node.jvm');
      return fly(event, false);
    }).then(function () {
      if (my !== gen) return;
      pulse('.node.ide');
    });
  }

  /* ---------- Pintar el estado ---------- */
  var prevKey = '';

  function render() {
    var s = idx >= 0 ? trace[idx] : null;
    var prev = idx > 0 ? trace[idx - 1] : null;

    lineEls.forEach(function (row) { if (row) row.classList.remove('cur'); });
    if (s && s.line) lineEls[s.line].classList.add('cur');

    // estado
    var st = el.status;
    st.className = 'badge';
    if (!s) st.textContent = 'Sin iniciar';
    else if (s.line === null) { st.textContent = 'Terminado'; st.classList.add('done'); }
    else { st.textContent = 'Pausada en la línea ' + s.line; st.classList.add('paused'); }

    // pila
    el.stack.textContent = '';
    if (!s || !s.frames.length) {
      el.stack.innerHTML = '<span class="empty">' + (s ? 'Vacía: ya no hay funciones.' : 'Aún no hay programa corriendo.') + '</span>';
    } else {
      var prevDepth = prev ? prev.frames.length : 0;
      for (var i = s.frames.length - 1; i >= 0; i--) {
        var f = s.frames[i];
        var d = document.createElement('div');
        d.className = 'frame' + (i === s.frames.length - 1 ? ' top' : '') + (i >= prevDepth ? ' new' : '');
        var a = document.createElement('span'); a.textContent = f.sig;
        var b = document.createElement('span'); b.className = 'ln'; b.textContent = 'línea ' + f.line;
        d.appendChild(a); d.appendChild(b);
        el.stack.appendChild(d);
      }
    }

    // variables (de la función de arriba)
    el.vars.textContent = '';
    if (s && s.frames.length) {
      var top = s.frames[s.frames.length - 1];
      var before = prev && prev.frames.length === s.frames.length ? prev.frames[prev.frames.length - 1] : null;
      Object.keys(top.vars).forEach(function (k) {
        var v = top.vars[k];
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.textContent = k;
        var td2 = document.createElement('td');
        if (v === undefined) { td2.textContent = 'sin valor'; td2.className = 'unset'; }
        else td2.textContent = String(v);
        var changed = before ? before.vars[k] !== v : v !== undefined;
        if (changed && v !== undefined) tr.className = 'changed';
        tr.appendChild(td1); tr.appendChild(td2);
        el.vars.appendChild(tr);
      });
    } else {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.colSpan = 2; td0.className = 'empty'; td0.textContent = '—';
      tr0.appendChild(td0); el.vars.appendChild(tr0);
    }

    // consola y nota
    el.cons.textContent = s ? s.out.join('\n') : '';
    el.note.innerHTML = s ? esc(s.note) : DEFAULT_NOTE;

    // botones
    var running = s && s.line !== null;
    el.start.disabled = !!s;
    el.resume.disabled = !running;
    el.over.disabled = !running;
    el.into.disabled = !running;
    el.out.disabled = !running;
    el.auto.disabled = !!s && !running;
    el.reset.disabled = !s;
  }

  /* ---------- Acciones ---------- */
  function nextBreak(from) {
    for (var i = from + 1; i < trace.length; i++) {
      if (trace[i].line === null || breakpoints[trace[i].line]) return i;
    }
    return trace.length - 1;
  }

  function nextWhere(from, test) {
    var d = trace[from].depth;
    for (var i = from + 1; i < trace.length; i++) if (test(trace[i].depth, d)) return i;
    return trace.length - 1;
  }

  function describeStop(i) {
    var s = trace[i];
    if (s.line === null) return 'Evento: VMDeath (el programa terminó)';
    return 'Evento: parada en la línea ' + s.line + ' + pila y variables';
  }

  function start() {
    if (idx >= 0) return;
    gen++;
    logMsg('jvm', 'Connect → SetBreakpoint ×' + Object.keys(breakpoints).length + ' → Resume');
    idx = nextBreak(-1);
    var my = gen;
    var s = trace[idx];
    logMsg('ide', s.line === null ? 'Evento: VMDeath (no había breakpoints)' :
      'Evento: breakpoint alcanzado en la línea ' + s.line);
    fly('Connect + Resume', true).then(function () {
      if (my !== gen) return;
      pulse('.node.jvm');
      return fly(s.line === null ? 'VMDeath' : 'Breakpoint línea ' + s.line, false);
    }).then(function () { if (my === gen) pulse('.node.ide'); });
    render();
  }

  function act(kind) {
    if (idx < 0 || trace[idx].line === null) return;
    var target, cmd;
    if (kind === 'resume') { target = nextBreak(idx); cmd = 'Resume'; }
    else if (kind === 'over') { target = nextWhere(idx, function (d, cur) { return d <= cur; }); cmd = 'Step (over)'; }
    else if (kind === 'into') { target = idx + 1; cmd = 'Step (into)'; }
    else { target = nextWhere(idx, function (d, cur) { return d < cur; }); cmd = 'Step (out)'; }

    var wasBreak = kind === 'resume' && trace[target].line !== null;
    var evt = wasBreak ? 'Evento: breakpoint en la línea ' + trace[target].line : describeStop(target);
    conversation(cmd, evt);
    idx = target;
    render();
    if (trace[idx].line === null) stopAuto();
  }

  function reset() {
    stopAuto();
    gen++;
    idx = -1;
    el.log.textContent = '';
    el.packet.style.opacity = 0;
    render();
  }

  function toggleBreakpoint(n) {
    var on = !breakpoints[n];
    if (on) breakpoints[n] = true; else delete breakpoints[n];
    paintBreakpoints();
    if (idx >= 0 && trace[idx].line !== null) {
      conversation((on ? 'SetBreakpoint' : 'ClearBreakpoint') + ' línea ' + n, 'Respuesta: OK');
    } else if (idx < 0) {
      logMsg('jvm', (on ? 'SetBreakpoint' : 'ClearBreakpoint') + ' línea ' + n + ' (se envía al conectar)');
    }
  }

  /* ---------- Modo automático ---------- */
  function stopAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    el.auto.classList.remove('on');
    el.auto.textContent = '🎬 Auto';
  }

  function autoStep() {
    if (idx < 0) start(); else act('into');
    if (idx >= 0 && trace[idx].line === null) { stopAuto(); return; }
    autoTimer = setTimeout(autoStep, parseInt(el.speed.value, 10));
  }

  function toggleAuto() {
    if (autoTimer) { stopAuto(); return; }
    el.auto.classList.add('on');
    el.auto.textContent = '⏸ Parar';
    autoStep();
  }

  /* ---------- Eventos ---------- */
  el.start.addEventListener('click', start);
  el.resume.addEventListener('click', function () { stopAuto(); act('resume'); });
  el.over.addEventListener('click', function () { stopAuto(); act('over'); });
  el.into.addEventListener('click', function () { stopAuto(); act('into'); });
  el.out.addEventListener('click', function () { stopAuto(); act('out'); });
  el.auto.addEventListener('click', toggleAuto);
  el.reset.addEventListener('click', reset);

  paintBreakpoints();
  render();
})();
