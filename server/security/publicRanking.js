'use strict';

function publicRanking(rows) {
  return rows.map(row => ({
    nickname: row.nickname || '名無し',
    total_points: row.total_points,
    tournament_count: row.tournament_count,
  }));
}

module.exports = { publicRanking };
