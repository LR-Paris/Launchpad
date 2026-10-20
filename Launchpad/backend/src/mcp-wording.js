// ---------------------------------------------------------------------------
// mcp-wording.js — fault wording for callers that come through the connector.
//
// Many resolutions were written for the web console, where "tell Gio" is the
// only road a person has. An assistant on the connector has another one:
// report_issue files the fault in a queue, and the person carries on. Gio
// asked not to be the relay for every fault (October 2026), so a fault
// refusal on the connector names the queue. Permission refusals keep their
// person, because who may do what is a decision, not a fault.
//
// Pure on purpose: no database, no Express, so a test can load it alone.
// ---------------------------------------------------------------------------
const REWRITES = [
  [/If it keeps (happening|failing), tell Gio and include the shop name\./g,
    'If it keeps $1, log it with report_issue, with the shop name, and carry on.'],
  [/If it keeps (happening|failing), tell Gio\./g,
    'If it keeps $1, log it with report_issue and carry on.'],
  [/^Tell Gio: (.+?)\.?$/,
    'Log it with report_issue: $1. Then carry on with what still works.'],
  [/^Send the DATABASE changes to Giovanni Lupo, who applies them by hand\.$/,
    'Log the change with report_issue: the shop, and what should change. The early shops take catalog changes by hand.'],
];

function forConnector(resolution) {
  if (typeof resolution !== 'string') return resolution;
  return REWRITES.reduce((text, [re, to]) => text.replace(re, to), resolution);
}

module.exports = { forConnector, REWRITES };
