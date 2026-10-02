'use strict';

/* Garavex V2 repair-order reopen workflow.
 * Reopening changes workflow state only. Existing invoice tokens, payment records,
 * QuickBooks references, and communication history remain intact.
 */
function installV2ReopenRepairOrder(app, db, { requireLogin }) {
  if (!app || !db || !requireLogin) throw new Error('V2 reopen repair order requires app, db, and requireLogin.');

  app.patch('/api/repair-orders/:id/reopen', requireLogin, (req, res) => {
    try {
      const shopId = Number(req.session?.employee?.shop_id || 0);
      const orderId = Number(req.params.id);
      if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Invalid repair order ID.' });

      const order = db.prepare(`
        SELECT id, status, completed_at, amount_paid, payment_status, invoice_token, quickbooks_invoice_id
        FROM repair_orders
        WHERE id = ? AND shop_id = ?
      `).get(orderId, shopId);

      if (!order) return res.status(404).json({ error: 'Repair order not found.' });
      if (String(order.status || '').toLowerCase() !== 'completed') {
        return res.status(409).json({ error: 'Only a completed repair order can be reopened.' });
      }

      db.prepare(`
        UPDATE repair_orders
        SET status = 'in_progress', completed_at = NULL
        WHERE id = ? AND shop_id = ?
      `).run(orderId, shopId);

      console.log('[V2 REOPEN] repair order reopened', {
        orderId,
        shopId,
        preservedAmountPaid: Number(order.amount_paid || 0),
        preservedPaymentStatus: order.payment_status || null,
        preservedInvoiceToken: Boolean(order.invoice_token),
        preservedQuickBooksInvoice: Boolean(order.quickbooks_invoice_id)
      });

      return res.json({
        success: true,
        id: orderId,
        status: 'in_progress',
        completed_at: null,
        financial_records_preserved: true,
        message: 'Repair order reopened and returned to In Progress.'
      });
    } catch (err) {
      console.error('[V2 REOPEN] failed:', err);
      return res.status(500).json({ error: 'Unable to reopen repair order.' });
    }
  });
}

module.exports = { installV2ReopenRepairOrder };
