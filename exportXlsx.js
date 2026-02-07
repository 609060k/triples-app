import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

export function exportToXlsx({
  summary,
  triplesAll,
  triplesLast30,
  gapsOver100,
  behaviorLag,
  behaviorCluster,
}) {
  const wb = XLSX.utils.book_new();

  const wsSummary = XLSX.utils.json_to_sheet(Object.entries(summary).map(([k, v]) => ({ מדד: k, ערך: v })));
  XLSX.utils.book_append_sheet(wb, wsSummary, 'סיכום');

  const ws30 = XLSX.utils.json_to_sheet(triplesLast30);
  XLSX.utils.book_append_sheet(wb, ws30, '30_שלשות_אחרונות');

  const wsAll = XLSX.utils.json_to_sheet(triplesAll);
  XLSX.utils.book_append_sheet(wb, wsAll, 'כל_השלשות');

  const wsGaps = XLSX.utils.json_to_sheet(gapsOver100);
  XLSX.utils.book_append_sheet(wb, wsGaps, 'איחורים_100+');

  const wsLag = XLSX.utils.json_to_sheet([behaviorLag]);
  XLSX.utils.book_append_sheet(wb, wsLag, 'התנהגות_איחור');

  const wsCl = XLSX.utils.json_to_sheet([behaviorCluster]);
  XLSX.utils.book_append_sheet(wb, wsCl, 'התנהגות_אשכול');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveAs(
    new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    'triples_export.xlsx'
  );
}
