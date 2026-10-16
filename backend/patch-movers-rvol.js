const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "..", "src", "App.jsx"); let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (!s.includes(a)) { console.error("anchor missing:", a.slice(0, 60)); process.exit(2); } s = s.replace(a, b); };
rep('JSON.stringify({ asOf: new Date().toISOString(), src: "auto", barDate, movers: kept })', 'JSON.stringify({ asOf: new Date().toISOString(), src: "auto", barDate, rvolBasis, movers: kept })');
rep('<Col title="◆ Volume spikes (RVOL)" col={C.amb} rows={volspikes} />\n        </div>\n      </>) : (',
    '<Col title="◆ Volume spikes (RVOL)" col={C.amb} rows={volspikes} />\n        </div>\n        {data.rvolBasis && <div style={{ color: C.mut, fontSize: 9, marginTop: 6 }}>Stock RVOL: {data.rvolBasis}{data.rvolBasis !== "daily" ? " — measured for the names shown and the 34 busiest; a dash means not measured. Crypto and FX use the daily bar." : " bar vs its 20-day average."}</div>}\n      </>) : (');
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("ok");
