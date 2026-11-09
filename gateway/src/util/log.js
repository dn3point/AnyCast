'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let current = LEVELS[process.env.ANYCAST_LOG || 'info'] ?? LEVELS.info;

function setLevel(name) {
  if (name in LEVELS) current = LEVELS[name];
}

function make(level) {
  return (scope, ...args) => {
    if (LEVELS[level] < current) return;
    const ts = new Date().toISOString().slice(11, 23);
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args);
  };
}

module.exports = {
  setLevel,
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
};
