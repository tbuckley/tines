/**
 * Client-side mirror of "this person pressed Got it on the personal-permission
 * notice". The layout's `disclosureAcknowledged` is the durable record; this
 * flips every notice on the page at once without reloading the layout, which
 * would re-derive the data an open form was built from. Only ever set in the
 * browser, so no request's server render sees another person's flag.
 */
export const disclosure = $state({ acknowledged: false });
