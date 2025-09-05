import React, { useEffect, useMemo, useRef, useState } from "react";

/** 한국 바둑 GO – Polished v2-lite (JSX)
 * - 그래픽: 목재 배경, 화점, 좌표, 윤광 돌(SVG)
 * - 플레이: 9/13/19줄, 자살/코 금지, 포획, 패스/기권
 * - 집계: 중국식(돌+영토) + 코미(기본 6.5)
 * - AI: 초급(휴리스틱), 중급(1수 앞보기), 고급(2수 앞보기·후보 제한)
 * - 외부 라이브러리 없음 → Vercel/CodeSandbox 안정 동작
 */

const LETTERS = "ABCDEFGHJKLMNOPQRST".split(""); // I 생략 관례
const other = (c) => (c === 1 ? 2 : 1);
const emptyBoard = (n) => Array.from({ length: n }, () => Array(n).fill(0));
const cloneBoard = (b) => b.map((r) => r.slice());
const serialize = (b) => b.map((r) => r.join("")).join("/");

function neighbors(x, y, n) {
  const res = [];
  if (x > 0) res.push([x - 1, y]);
  if (x < n - 1) res.push([x + 1, y]);
  if (y > 0) res.push([x, y - 1]);
  if (y < n - 1) res.push([x, y + 1]);
  return res;
}

function groupAndLiberties(board, x, y) {
  const n = board.length;
  const color = board[x][y];
  if (!color) return { stones: [], liberties: new Set() };
  const stones = [];
  const libs = new Set();
  const seen = new Set();
  const key = (a, b) => `${a},${b}`;
  const st = [[x, y]];
  while (st.length) {
    const [cx, cy] = st.pop();
    const k = key(cx, cy);
    if (seen.has(k)) continue;
    seen.add(k);
    stones.push([cx, cy]);
    for (const [nx, ny] of neighbors(cx, cy, n)) {
      const v = board[nx][ny];
      if (v === 0) libs.add(key(nx, ny));
      else if (v === color && !seen.has(key(nx, ny))) st.push([nx, ny]);
    }
  }
  return { stones, liberties: libs };
}

function tryPlay(board, x, y, color, koPrevHashRef) {
  const n = board.length;
  if (board[x][y] !== 0) return { legal: false };
  const nb = cloneBoard(board);
  nb[x][y] = color;
  const enemy = other(color);
  let captured = 0;

  // 인접 적군 포획
  for (const [nx, ny] of neighbors(x, y, n)) {
    if (nb[nx][ny] === enemy) {
      const g = groupAndLiberties(nb, nx, ny);
      if (g.liberties.size === 0) {
        for (const [sx, sy] of g.stones) {
          nb[sx][sy] = 0;
          captured++;
        }
      }
    }
  }

  // 자살수 금지
  const selfG = groupAndLiberties(nb, x, y);
  if (selfG.liberties.size === 0 && captured === 0) return { legal: false };

  const hash = serialize(nb);
  // 단순 코: 직전-직전 국면 동일 금지
  if (koPrevHashRef?.current && hash === koPrevHashRef.current)
    return { legal: false };

  return { legal: true, board: nb, captured, hash };
}

function legalMoves(board, color, koPrevHashRef) {
  const n = board.length;
  const res = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (board[x][y] !== 0) continue;
      const r = tryPlay(board, x, y, color, koPrevHashRef);
      if (r.legal) res.push({ x, y, ...r });
    }
  }
  return res;
}

// 중국식 간이 집계 (돌+영토) + 코미
function scoreChinese(board, komi = 6.5) {
  const n = board.length;
  let blackStones = 0,
    whiteStones = 0;
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      if (board[x][y] === 1) blackStones++;
      else if (board[x][y] === 2) whiteStones++;
    }

  const seen = new Set();
  const key = (a, b) => `${a},${b}`;
  let bTerr = 0,
    wTerr = 0;

  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      if (board[x][y] !== 0) continue;
      const k0 = key(x, y);
      if (seen.has(k0)) continue;
      let q = [[x, y]];
      seen.add(k0);
      const region = [[x, y]];
      const nbs = new Set();
      while (q.length) {
        const [cx, cy] = q.pop();
        for (const [nx, ny] of neighbors(cx, cy, n)) {
          const v = board[nx][ny];
          if (v === 0) {
            const kk = key(nx, ny);
            if (!seen.has(kk)) {
              seen.add(kk);
              q.push([nx, ny]);
              region.push([nx, ny]);
            }
          } else nbs.add(v);
        }
      }
      if (nbs.size === 1) {
        const owner = [...nbs][0];
        if (owner === 1) bTerr += region.length;
        else if (owner === 2) wTerr += region.length;
      }
    }

  const bScore = blackStones + bTerr;
  const wScore = whiteStones + wTerr + komi;
  return {
    bScore,
    wScore,
    diff: bScore - wScore,
    detail: { blackStones, whiteStones, bTerr, wTerr },
  };
}

/** 난이도별 AI */
function chooseMove(board, color, koPrevHashRef, difficulty, komi) {
  const n = board.length;
  const moves = legalMoves(board, color, koPrevHashRef);
  if (moves.length === 0) return null;
  const enemy = other(color);
  const center = (n - 1) / 2;

  // 휴리스틱 스코어러
  const heur = (mv) => {
    const { x, y, captured, board: nb } = mv;
    const g = groupAndLiberties(nb, x, y);
    const selfAtari = g.liberties.size <= 1 ? -3 : 0;
    let friendlyAdj = 0,
      enemyAdj = 0;
    for (const [nx, ny] of neighbors(x, y, n)) {
      if (board[nx][ny] === color) friendlyAdj++;
      if (board[nx][ny] === enemy) enemyAdj++;
    }
    const dist = Math.hypot(x - center, y - center);
    const centerBonus = 4 - dist;
    return (
      captured * 10 +
      friendlyAdj * 1.6 +
      enemyAdj * 0.6 +
      centerBonus +
      selfAtari
    );
  };

  const evaluateBoardFor = (b, c) => {
    const { diff } = scoreChinese(b, komi); // 흑-백
    return c === 1 ? diff : -diff;
  };

  const scored = moves
    .map((m) => ({ ...m, h: heur(m) }))
    .sort((a, b) => b.h - a.h);

  if (difficulty === "beginner") {
    const topK = Math.max(1, Math.min(6, Math.floor(scored.length * 0.25)));
    return scored[Math.floor(Math.random() * topK)];
  }

  if (difficulty === "intermediate") {
    // 1수 앞보기
    let best = scored[0],
      bestV = -Infinity;
    for (const mv of scored.slice(0, 16)) {
      const v = evaluateBoardFor(mv.board, color) + mv.h * 0.3;
      if (v > bestV) {
        bestV = v;
        best = mv;
      }
    }
    return best;
  }

  // advanced: 2수 앞보기(상대 최선 가정, 후보 제한)
  let best = scored[0],
    bestV = -Infinity;
  const ourCandidates = scored.slice(0, 12);
  for (const mv of ourCandidates) {
    const replies = legalMoves(mv.board, other(color), koPrevHashRef)
      .map((r) => ({ ...r, h: heur(r) }))
      .sort((a, b) => b.h - a.h)
      .slice(0, 8);

    if (replies.length === 0) {
      const v = evaluateBoardFor(mv.board, color) + mv.h * 0.2;
      if (v > bestV) {
        bestV = v;
        best = mv;
      }
      continue;
    }

    let worstForUs = +Infinity;
    for (const r of replies) {
      const vOpp = evaluateBoardFor(r.board, color) - r.h * 0.1; // 우리 관점 점수(낮을수록 나쁨)
      if (vOpp < worstForUs) worstForUs = vOpp;
    }
    const val = worstForUs + mv.h * 0.2;
    if (val > bestV) {
      bestV = val;
      best = mv;
    }
  }
  return best;
}

/** 그래픽 컴포넌트 */
function Stone({ cx, cy, r, color, last }) {
  const id = color === 1 ? "gradBlack" : "gradWhite";
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={`url(#${id})`}
        stroke={color === 2 ? "#d0d0d0" : "#333"}
      />
      {last && (
        <circle
          cx={cx}
          cy={cy}
          r={r * 0.25}
          fill={color === 1 ? "#f2f2f2" : "#1a1a1a"}
          opacity="0.9"
        />
      )}
    </g>
  );
}

function Board({
  size,
  board,
  lastMove,
  interactive,
  onPlay,
  hover,
  setHover,
  ghostColor,
}) {
  const n = size;
  const margin = 24;
  const W = 720;
  const cell = (W - margin * 2) / (n - 1);
  const xyToCoord = (x, y) => [margin + x * cell, margin + y * cell];

  const starPts = React.useMemo(() => {
    if (n === 9)
      return [
        [2, 2],
        [6, 2],
        [2, 6],
        [6, 6],
        [4, 4],
      ];
    if (n === 13)
      return [
        [3, 3],
        [9, 3],
        [3, 9],
        [9, 9],
        [6, 6],
      ];
    if (n === 19)
      return [
        [3, 3],
        [9, 3],
        [15, 3],
        [3, 9],
        [9, 9],
        [15, 9],
        [3, 15],
        [9, 15],
        [15, 15],
      ];
    return [];
  }, [n]);

  const handleClick = () => {
    if (!interactive || !hover) return;
    onPlay(hover.x, hover.y);
  };

  const handleMouseMove = (evt) => {
    if (!interactive) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const rx = evt.clientX - rect.left,
      ry = evt.clientY - rect.top;
    let best = null,
      bestD = Infinity;
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        const [cx, cy] = xyToCoord(x, y);
        const d =
          (cx - rx * (W / rect.width)) ** 2 +
          (cy - ry * (W / rect.height)) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y, cx, cy };
        }
      }
    setHover(best);
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${W}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHover(null)}
      onClick={handleClick}
      style={{
        width: "100%",
        height: "auto",
        borderRadius: 16,
        boxShadow: "0 12px 30px rgba(0,0,0,.18)",
        background:
          "radial-gradient(ellipse at center, rgba(255,210,120,0.35) 0%, rgba(160,120,70,0.35) 60%, rgba(120,80,40,0.35) 100%)",
      }}
    >
      <defs>
        <radialGradient id="gradBlack" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#3a3a3a" />
          <stop offset="60%" stopColor="#0f0f0f" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
        <radialGradient id="gradWhite" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#e6e6e6" />
          <stop offset="100%" stopColor="#cfcfcf" />
        </radialGradient>
      </defs>

      {/* 외곽 프레임 */}
      <rect
        x={margin}
        y={margin}
        width={cell * (n - 1)}
        height={cell * (n - 1)}
        fill="none"
        stroke="#3a2a12"
        strokeWidth="2"
      />

      {/* 격자 */}
      {Array.from({ length: n }).map((_, i) => (
        <line
          key={`h-${i}`}
          x1={margin}
          y1={margin + i * cell}
          x2={margin + (n - 1) * cell}
          y2={margin + i * cell}
          stroke="#3a2a12"
          strokeWidth="1"
        />
      ))}
      {Array.from({ length: n }).map((_, i) => (
        <line
          key={`v-${i}`}
          x1={margin + i * cell}
          y1={margin}
          x2={margin + i * cell}
          y2={margin + (n - 1) * cell}
          stroke="#3a2a12"
          strokeWidth="1"
        />
      ))}

      {/* 화점 */}
      {starPts.map(([sx, sy], i) => {
        const [cx, cy] = xyToCoord(sx, sy);
        return <circle key={i} cx={cx} cy={cy} r={4} fill="#2a1a0a" />;
      })}

      {/* 좌표 라벨 */}
      {Array.from({ length: n }).map((_, i) => {
        const [cx] = xyToCoord(i, 0);
        const label = LETTERS[i];
        return (
          <text
            key={`tx-${i}`}
            x={cx}
            y={margin - 6}
            fontSize="12"
            textAnchor="middle"
            fill="#5a4a2a"
          >
            {label}
          </text>
        );
      })}
      {Array.from({ length: n }).map((_, i) => {
        const [, cy] = xyToCoord(0, i);
        const label = n - i;
        return (
          <text
            key={`ty-${i}`}
            x={margin - 10}
            y={cy + 4}
            fontSize="12"
            textAnchor="end"
            fill="#5a4a2a"
          >
            {label}
          </text>
        );
      })}

      {/* 돌 */}
      {board.map((col, x) =>
        col.map((v, y) => {
          if (!v) return null;
          const [cx, cy] = xyToCoord(x, y);
          const r = cell * 0.45;
          const isLast = lastMove && lastMove.x === x && lastMove.y === y;
          return (
            <Stone
              key={`${x}-${y}`}
              cx={cx}
              cy={cy}
              r={r}
              color={v}
              last={isLast}
            />
          );
        })
      )}

      {/* 착점 미리보기 */}
      {interactive && hover && board[hover.x][hover.y] === 0 && (
        <g opacity="0.35">
          <Stone
            cx={hover.cx}
            cy={hover.cy}
            r={cell * 0.45}
            color={ghostColor}
          />
        </g>
      )}
    </svg>
  );
}

/** 메인 앱 */
export default function App() {
  useEffect(() => {
    document.title = "한국스러운 바둑 - 챗GPT와 한판 시작!";
  }, []);

  const [size, setSize] = useState(9);
  const [komi, setKomi] = useState(6.5);
  const [board, setBoard] = useState(() => emptyBoard(9));
  const [turn, setTurn] = useState(1); // 1 흑, 2 백
  const [playerColor, setPlayerColor] = useState(1); // 사용자 흑(선)
  const [lastMove, setLastMove] = useState(null);
  const [hover, setHover] = useState(null);
  const [captBlack, setCaptBlack] = useState(0); // 흑이 잡은 수
  const [captWhite, setCaptWhite] = useState(0); // 백이 잡은 수
  const [passes, setPasses] = useState(0);
  const [over, setOver] = useState(false);
  const [difficulty, setDifficulty] = useState("beginner"); // beginner|intermediate|advanced
  const [aiThinking, setAiThinking] = useState(false);
  const koPrevHashRef = useRef(null);
  const [history, setHistory] = useState([serialize(emptyBoard(9))]);

  useEffect(() => {
    const b = emptyBoard(size);
    setBoard(b);
    setTurn(1);
    setPlayerColor(1);
    setLastMove(null);
    setHover(null);
    setCaptBlack(0);
    setCaptWhite(0);
    setPasses(0);
    setOver(false);
    koPrevHashRef.current = null;
    setHistory([serialize(b)]);
  }, [size]);

  const aiColor = playerColor === 1 ? 2 : 1;
  const isPlayerTurn = turn === playerColor && !over;

  const onPlay = (x, y) => {
    if (!isPlayerTurn) return;
    const res = tryPlay(board, x, y, playerColor, koPrevHashRef);
    if (!res.legal) return;
    setBoard(res.board);
    setTurn(aiColor);
    setLastMove({ x, y, color: playerColor });
    setPasses(0);
    if (playerColor === 1) setCaptBlack((c) => c + res.captured);
    else setCaptWhite((c) => c + res.captured);
    setHistory((h) => {
      const next = [...h, res.hash];
      koPrevHashRef.current = h[h.length - 1] ?? null;
      return next;
    });
  };

  const doPass = () => {
    if (over) return;
    setPasses((p) => {
      const np = p + 1;
      if (np >= 2) setOver(true);
      return np;
    });
    setTurn(turn === 1 ? 2 : 1);
    setLastMove(null);
  };
  const resign = () => setOver(true);
  const restart = () => {
    const b = emptyBoard(size);
    setBoard(b);
    setTurn(1);
    setLastMove(null);
    setHover(null);
    setCaptBlack(0);
    setCaptWhite(0);
    setPasses(0);
    setOver(false);
    setHistory([serialize(b)]);
    koPrevHashRef.current = null;
  };
  const switchSides = () => {
    if (!over && serialize(board) !== serialize(emptyBoard(size)))
      return alert("진행 중에는 진영 변경 불가. 재시작 후 변경하세요.");
    setPlayerColor((c) => (c === 1 ? 2 : 1));
    restart();
  };

  // AI 턴
  useEffect(() => {
    if (over || turn !== aiColor) return;
    setAiThinking(true);
    const t = setTimeout(() => {
      const mv = chooseMove(board, aiColor, koPrevHashRef, difficulty, komi);
      if (!mv) {
        setPasses((p) => {
          const np = p + 1;
          if (np >= 2) setOver(true);
          return np;
        });
        setTurn(playerColor);
        setAiThinking(false);
        return;
      }
      setBoard(mv.board);
      setTurn(playerColor);
      setLastMove({ x: mv.x, y: mv.y, color: aiColor });
      setPasses(0);
      if (aiColor === 1) setCaptBlack((c) => c + mv.captured);
      else setCaptWhite((c) => c + mv.captured);
      setHistory((h) => {
        const next = [...h, mv.hash];
        koPrevHashRef.current = h[h.length - 1] ?? null;
        return next;
      });
      setAiThinking(false);
    }, 160);
    return () => clearTimeout(t);
  }, [turn, aiColor, playerColor, board, over, difficulty, komi]);

  const { bScore, wScore, diff, detail } = useMemo(
    () => scoreChinese(board, komi),
    [board, komi]
  );

  return (
    <div className="wrap">
      <div className="container topbar">
        <div className="brand">
          <div className="brand-badge">Go</div>
          <div className="brand-title">한국 바둑 GO</div>
        </div>
        <a className="top-btn" href="#" onClick={(e) => e.preventDefault()}>
          도움말
        </a>
      </div>

      <div className="container">
        <h1 className="title">한국 바둑 - 챗GPT와 한판 시작!</h1>
        <p className="subtitle">
          심심할 때 한판 두는 기분 좋은 한국 바둑 고! 지금 시작하세요~!
        </p>
      </div>

      <div className="container grid">
        {/* 보드 */}
        <div className="card wood">
          <Board
            size={size}
            board={board}
            lastMove={lastMove}
            interactive={isPlayerTurn}
            onPlay={onPlay}
            hover={hover}
            setHover={setHover}
            ghostColor={playerColor}
          />
          {over && (
            <div className="card" style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>게임 종료</div>
              <div>중국식 집계(돌+영토) 기준 결과입니다. (코미 {komi})</div>
              <div style={{ marginTop: 4 }}>
                흑: {bScore.toFixed(1)} / 백: {wScore.toFixed(1)} →{" "}
                {diff > 0 ? "흑 우세" : diff < 0 ? "백 우세" : "접전"}
              </div>
              <div
                style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}
              >
                상세: 흑(돌 {detail.blackStones} + 영토 {detail.bTerr}) / 백(돌{" "}
                {detail.whiteStones} + 영토 {detail.wTerr} + 코미 {komi})
              </div>
            </div>
          )}
        </div>

        {/* 설정 패널 */}
        <div className="card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800 }}>설정 & 상태</div>
            <span
              className={`badge ${isPlayerTurn ? "badge-green" : "badge-blue"}`}
            >
              {isPlayerTurn
                ? "당신 차례"
                : aiThinking
                ? "AI 생각 중…"
                : "AI 차례"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0,1fr))",
              gap: 8,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--muted)",
              }}
            >
              줄 수
              <select
                value={size}
                onChange={(e) => setSize(parseInt(e.target.value))}
                className="btn"
              >
                <option value={9}>9</option>
                <option value={13}>13</option>
                <option value={19}>19</option>
              </select>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--muted)",
              }}
            >
              난이도
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="btn"
              >
                <option value="beginner">초급</option>
                <option value="intermediate">중급</option>
                <option value="advanced">고급</option>
              </select>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--muted)",
              }}
            >
              코미
              <input
                type="number"
                step="0.5"
                value={komi}
                onChange={(e) => setKomi(parseFloat(e.target.value))}
                className="btn"
                style={{ width: 90 }}
              />
            </label>
            <button onClick={switchSides} className="btn">
              진영: {playerColor === 1 ? "흑(선)" : "백(후)"} ↔
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0,1fr))",
              gap: 8,
              marginTop: 8,
            }}
          >
            <div className="stat">
              <div className="label">흑 포획</div>
              <div className="val">{captBlack}</div>
            </div>
            <div className="stat">
              <div className="label">백 포획</div>
              <div className="val">{captWhite}</div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={doPass} className="btn btn-primary">
              패스
            </button>
            <button onClick={resign} className="btn">
              기권
            </button>
            <button
              onClick={restart}
              className="btn btn-dark"
              style={{ marginLeft: "auto" }}
            >
              재시작
            </button>
          </div>

          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
            규칙: 자살수/단순 코 금지. 두 번 연속 패스 시 종료. 집계는
            중국식(돌+영토)과 코미를 사용합니다.
          </div>
        </div>
      </div>

      <div
        className="container"
        style={{
          fontSize: 12,
          color: "var(--muted)",
          borderTop: "1px solid var(--line)",
          paddingTop: 12,
        }}
      >
        © {new Date().getFullYear()} 한국 바둑 GO – 그래픽·AI 개선 요청 환영!
      </div>
    </div>
  );
}
