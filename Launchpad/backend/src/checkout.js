const express = require('express');
const fs = require('fs');
const path = require('path');
const { checkShopPermission } = require('./users');
const { resolveShopAndRole, requireShopAccess, audit } = require('./authz');
const router = express.Router();

// ---------------------------------------------------------------------------
// ADR-001, fixed here. This router is mounted on '/api/shops' in index.js, but
// every path inside it used to start with '/shops/:slug', so what it really
// served was /api/shops/shops/:slug/checkout/schema. The frontend has always
// called /api/shops/:slug/checkout/schema (frontend/src/lib/api.js, getCheckoutSchema
// and saveCheckoutSchema, on an axios instance with baseURL '/api'). Nothing
// answered that, so the checkout schema editor has been dead for as long as the
// double prefix has been there, and PUT has been silently failing with a 404.
//
// The fix is in the router rather than in the mount, so the mount line in
// index.js keeps sitting with every other /api/shops router and the shop-access
// floor covers it the same way.
//
// Nothing could have depended on the broken path: it was never in the frontend,
// never in the MCP client, and a shop container has no reason to read its own
// checkout schema over HTTP.
// ---------------------------------------------------------------------------
router.use('/:slug', resolveShopAndRole, requireShopAccess({ GET: 'viewer', default: 'editor' }));

const VALID_SLUG = /^[a-zA-Z0-9_-]+$/;

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

function getSchemaPath(slug) {
  return path.join(SHOPS_DIR, slug, 'DATABASE', 'Checkout', 'schema.json');
}

const DEFAULT_SCHEMA = {
  sections: [
    {
      id: 'contact', title: 'Contact Information', type: 'fields', enabled: true,
      fields: [
        { id: 'firstName', label: 'First Name', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'lastName', label: 'Last Name', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'email', label: 'Email', type: 'email', required: true, width: 'half', placeholder: '' },
        { id: 'phone', label: 'Phone', type: 'tel', required: true, width: 'half', placeholder: '' },
        { id: 'company', label: 'Company', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'country', label: 'Country', type: 'text', required: false, width: 'half', placeholder: 'e.g. United States' },
      ],
    },
    {
      id: 'shipping', title: 'Shipping Address', type: 'fields', enabled: true,
      fields: [
        { id: 'address', label: 'Address', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'apt', label: 'Apt, suite, etc.', type: 'text', required: false, width: 'half', placeholder: 'Optional' },
        { id: 'city', label: 'City', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'state', label: 'State / Province', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'postalCode', label: 'ZIP / Postal Code', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'shippingCountry', label: 'Country', type: 'text', required: true, width: 'full', placeholder: 'e.g. United States' },
      ],
    },
    {
      id: 'billing', title: 'Billing Information', type: 'fields', enabled: true,
      fields: [
        { id: 'billingSameAsShipping', label: 'Same as shipping address', type: 'checkbox', required: false, width: 'full', placeholder: '' },
        { id: 'billingName', label: 'Billing Name', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'billingAddress', label: 'Billing Address', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'billingCity', label: 'City', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'billingZip', label: 'ZIP Code', type: 'text', required: true, width: 'half', placeholder: '' },
        { id: 'billingCountry', label: 'Country', type: 'text', required: true, width: 'full', placeholder: '' },
      ],
    },
    {
      id: 'freight', title: 'Freight Options', type: 'freight', enabled: true,
      lrOption: { label: 'Use LR Paris freight forwarder', description: "We'll arrange shipping through our partner LR Paris" },
      ownOption: { label: 'Use my freight forwarder', description: 'Provide your freight forwarder details below' },
      ownFields: [
        { id: 'freightCompany', label: 'Freight Company Name', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'freightAccount', label: 'Account Number', type: 'text', required: true, width: 'full', placeholder: '' },
        { id: 'freightContact', label: 'Contact Information', type: 'text', required: true, width: 'full', placeholder: 'Phone and/or email' },
      ],
    },
    {
      id: 'notes', title: 'Order Notes', type: 'fields', enabled: true,
      fields: [
        { id: 'orderNotes', label: 'Order Notes', type: 'textarea', required: false, width: 'full', placeholder: 'Any special instructions or notes for this order (optional)' },
      ],
    },
  ],
};

// GET /api/shops/:slug/checkout/schema
router.get('/:slug/checkout/schema', (req, res) => {
  const { slug } = req.params;
  if (!VALID_SLUG.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  const schemaPath = getSchemaPath(slug);
  try {
    if (fs.existsSync(schemaPath)) {
      const data = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      return res.json(data);
    }
    return res.json(DEFAULT_SCHEMA);
  } catch (err) {
    console.error('Error reading checkout schema:', err);
    return res.json(DEFAULT_SCHEMA);
  }
});

// PUT /api/shops/:slug/checkout/schema
router.put('/:slug/checkout/schema', (req, res) => {
  const { slug } = req.params;
  if (!VALID_SLUG.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const schema = req.body;
  if (!schema || !Array.isArray(schema.sections)) {
    return res.status(400).json({ error: 'Invalid schema: must have sections array' });
  }
  const schemaPath = getSchemaPath(slug);
  try {
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
    const audit_id = audit(req, 'checkout_schema_saved', { slug, sections: schema.sections.length });
    return res.json({ success: true, audit_id });
  } catch (err) {
    console.error('Error saving checkout schema:', err);
    return res.status(500).json({ error: 'Failed to save schema' });
  }
});

module.exports = router;
