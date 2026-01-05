/**
 * Late Orders Alert Service
 *
 * Sends daily alerts to Teams with:
 * - Summary table of pending/late orders by sales channel
 * - Excel attachment with all late orders and Odoo links
 *
 * Supports:
 * - Sending to Teams channels (via webhook)
 * - Sending to individual users (via MS Graph API)
 *
 * @module LateOrdersAlertService
 */

const { MongoClient } = require('mongodb');
const ExcelJS = require('exceljs');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');
const { MicrosoftDirectClient } = require('../../core/agents/integrations/MicrosoftMCP');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getDb } = require('../../db');

// Sales Team to Channel mapping
const TEAM_CHANNEL_MAP = {
  11: 'Amazon Seller', 5: 'Amazon Seller', 16: 'Amazon Seller', 17: 'Amazon Seller',
  18: 'Amazon Seller', 19: 'Amazon Seller', 20: 'Amazon Seller', 21: 'Amazon Seller',
  22: 'Amazon Seller', 24: 'Amazon Seller', 25: 'Amazon Seller',
  6: 'Amazon Vendor',
  8: 'BOL', 9: 'BOL', 10: 'BOL',
  1: 'Sales', 2: 'Sales', 3: 'Sales', 4: 'Sales', 7: 'Sales'
};

// Odoo base URL for links
const ODOO_BASE_URL = process.env.ODOO_URL || 'https://acropaq.odoo.com';

class LateOrdersAlertService {
  constructor() {
    this.odoo = null;
    this.db = null;
    this.teamsWebhook = null;
    this.msGraph = null;
  }

  async init() {
    if (this.odoo) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.db = getDb();

    // Initialize Teams webhook service
    if (process.env.TEAMS_LATE_ORDERS_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL) {
      this.teamsWebhook = new TeamsNotificationService({
        webhookUrl: process.env.TEAMS_LATE_ORDERS_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL
      });
    }

    // Initialize MS Graph for individual user messages
    if (process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) {
      this.msGraph = new MicrosoftDirectClient();
    }
  }

  /**
   * Gather all pending orders data with deadlines
   */
  async gatherOrderData() {
    await this.init();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get all CW/OUT pending pickings (paginate to avoid Odoo's default 100 limit)
    let allPickings = [];
    let offset = 0;
    const BATCH_SIZE = 1000;
    while (true) {
      const batch = await this.odoo.searchRead('stock.picking',
        [['name', 'like', 'CW/OUT/%'], ['state', 'in', ['assigned', 'confirmed', 'waiting']]],
        ['id', 'name', 'sale_id', 'scheduled_date', 'partner_id'],
        { limit: BATCH_SIZE, offset, order: 'id asc' }
      );
      allPickings = allPickings.concat(batch);
      if (batch.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    // Get sale order details (paginate for large sets)
    const saleIds = [...new Set(allPickings.filter(p => p.sale_id).map(p => p.sale_id[0]))];
    let saleOrders = [];
    for (let i = 0; i < saleIds.length; i += 500) {
      const batchIds = saleIds.slice(i, i + 500);
      const batch = await this.odoo.searchRead('sale.order',
        [['id', 'in', batchIds]],
        ['id', 'name', 'client_order_ref', 'team_id', 'partner_id', 'amount_total', 'date_order'],
        { limit: 500 }
      );
      saleOrders = saleOrders.concat(batch);
    }
    const soMap = {};
    saleOrders.forEach(so => soMap[so.id] = so);

    // Process each picking and determine deadline
    const orders = [];
    const channelStats = {};

    for (const picking of allPickings) {
      const so = picking.sale_id ? soMap[picking.sale_id[0]] : null;
      const teamId = so?.team_id?.[0] || 0;
      const channel = TEAM_CHANNEL_MAP[teamId] || 'Other';

      if (!channelStats[channel]) {
        channelStats[channel] = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0 };
      }
      channelStats[channel].pending++;

      // Get deadline based on channel
      let deadline = null;
      let deadlineSource = 'scheduled_date';

      if (channel === 'Amazon Seller') {
        // Get from unified_orders.shippingDeadline
        const ref = so?.client_order_ref?.match(/\d{3}-\d{7}-\d{7}/)?.[0] ||
                   so?.name?.match(/\d{3}-\d{7}-\d{7}/)?.[0];
        if (ref) {
          const uOrder = await this.db.collection('unified_orders').findOne({
            'sourceIds.amazonOrderId': ref
          });
          if (uOrder?.shippingDeadline) {
            deadline = new Date(uOrder.shippingDeadline);
            deadlineSource = 'Amazon latestShipDate';
          }
        }
      } else if (channel === 'Amazon Vendor') {
        // Get from vendor_orders.requestedDeliveryDate
        if (so?.client_order_ref) {
          const vOrder = await this.db.collection('vendor_orders').findOne({
            purchaseOrderNumber: so.client_order_ref
          });
          if (vOrder?.requestedDeliveryDate) {
            deadline = new Date(vOrder.requestedDeliveryDate);
            deadlineSource = 'Vendor requestedDeliveryDate';
          }
        }
      } else if (channel === 'BOL') {
        // Get from bol_orders.latestDeliveryDate
        if (so?.client_order_ref) {
          const bOrder = await this.db.collection('bol_orders').findOne({ orderId: so.client_order_ref });
          if (bOrder?.latestDeliveryDate) {
            deadline = new Date(bOrder.latestDeliveryDate);
            deadlineSource = 'BOL latestDeliveryDate';
          }
        }
      }

      // Fallback to Odoo scheduled_date
      if (!deadline && picking.scheduled_date) {
        deadline = new Date(picking.scheduled_date);
      }

      // Categorize by deadline
      let status = 'noDeadline';
      let daysLate = 0;

      if (deadline) {
        const dlDate = new Date(deadline);
        dlDate.setHours(0, 0, 0, 0);

        if (dlDate < today) {
          status = 'late';
          daysLate = Math.floor((today - dlDate) / (1000 * 60 * 60 * 24));
          channelStats[channel].late++;
        } else if (dlDate.getTime() === today.getTime()) {
          status = 'dueToday';
          channelStats[channel].dueToday++;
        } else if (dlDate.getTime() === tomorrow.getTime()) {
          status = 'dueTomorrow';
          channelStats[channel].dueTomorrow++;
        } else {
          status = 'upcoming';
          channelStats[channel].upcoming++;
        }
      } else {
        channelStats[channel].noDeadline++;
      }

      orders.push({
        pickingId: picking.id,
        pickingName: picking.name,
        saleOrderId: so?.id,
        saleOrderName: so?.name,
        clientRef: so?.client_order_ref,
        channel,
        teamId,
        customer: picking.partner_id ? picking.partner_id[1] : (so?.partner_id ? so.partner_id[1] : 'Unknown'),
        amount: so?.amount_total || 0,
        orderDate: so?.date_order,
        deadline,
        deadlineSource,
        status,
        daysLate,
        odooUrl: so?.id ? `${ODOO_BASE_URL}/web#id=${so.id}&model=sale.order&view_type=form` : null
      });
    }

    return { orders, channelStats, today };
  }

  /**
   * Generate Excel file with late orders
   */
  async generateExcel(orders) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Late Orders Alert';
    workbook.created = new Date();

    // Late orders sheet
    const lateSheet = workbook.addWorksheet('Late Orders', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }]
    });

    lateSheet.columns = [
      { header: 'Picking', key: 'pickingName', width: 15 },
      { header: 'Sale Order', key: 'saleOrderName', width: 20 },
      { header: 'Channel', key: 'channel', width: 15 },
      { header: 'Customer', key: 'customer', width: 30 },
      { header: 'Amount', key: 'amount', width: 12 },
      { header: 'Order Date', key: 'orderDate', width: 12 },
      { header: 'Deadline', key: 'deadline', width: 12 },
      { header: 'Days Late', key: 'daysLate', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Odoo Link', key: 'odooUrl', width: 50 }
    ];

    // Style header row
    lateSheet.getRow(1).font = { bold: true };
    lateSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    lateSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Filter and sort: late orders first, then due today
    const priorityOrders = orders
      .filter(o => o.status === 'late' || o.status === 'dueToday')
      .sort((a, b) => {
        if (a.status === 'late' && b.status !== 'late') return -1;
        if (b.status === 'late' && a.status !== 'late') return 1;
        return b.daysLate - a.daysLate;
      });

    for (const order of priorityOrders) {
      const row = lateSheet.addRow({
        pickingName: order.pickingName,
        saleOrderName: order.saleOrderName || 'N/A',
        channel: order.channel,
        customer: order.customer,
        amount: order.amount,
        orderDate: order.orderDate ? new Date(order.orderDate).toLocaleDateString() : '',
        deadline: order.deadline ? new Date(order.deadline).toLocaleDateString() : '',
        daysLate: order.daysLate,
        status: order.status === 'late' ? 'LATE' : 'Due Today',
        odooUrl: order.odooUrl || ''
      });

      // Color code by status
      if (order.status === 'late') {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' } // Light red
        };
      } else if (order.status === 'dueToday') {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFEB9C' } // Light yellow
        };
      }

      // Make Odoo URL a hyperlink
      if (order.odooUrl) {
        row.getCell('odooUrl').value = {
          text: 'Open in Odoo',
          hyperlink: order.odooUrl
        };
        row.getCell('odooUrl').font = { color: { argb: 'FF0563C1' }, underline: true };
      }
    }

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Channel', key: 'channel', width: 20 },
      { header: 'Total Pending', key: 'pending', width: 15 },
      { header: 'Late', key: 'late', width: 10 },
      { header: 'Due Today', key: 'dueToday', width: 12 },
      { header: 'Tomorrow', key: 'dueTomorrow', width: 12 },
      { header: 'Upcoming', key: 'upcoming', width: 12 }
    ];

    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Generate Excel buffer
    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Build Teams Adaptive Card with summary table
   */
  buildTeamsCard(channelStats, today) {
    const channels = ['Amazon Seller', 'Amazon Vendor', 'BOL', 'Sales', 'Other'];
    const totals = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0 };

    const rows = [];
    for (const ch of channels) {
      const d = channelStats[ch];
      if (!d || d.pending === 0) continue;

      totals.pending += d.pending;
      totals.late += d.late;
      totals.dueToday += d.dueToday;
      totals.dueTomorrow += d.dueTomorrow;
      totals.upcoming += d.upcoming;

      const lateEmoji = d.late > 0 ? '🔴 ' : '';
      const todayEmoji = d.dueToday > 0 ? '🟠 ' : '';

      rows.push({
        type: 'TableRow',
        cells: [
          { type: 'TableCell', items: [{ type: 'TextBlock', text: ch, wrap: true }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: String(d.pending) }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: `${lateEmoji}${d.late}`, color: d.late > 0 ? 'attention' : 'default' }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: `${todayEmoji}${d.dueToday}`, color: d.dueToday > 0 ? 'warning' : 'default' }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: String(d.dueTomorrow) }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: String(d.upcoming) }] }
        ]
      });
    }

    // Total row
    const totalLateEmoji = totals.late > 0 ? '🔴 ' : '';
    const totalTodayEmoji = totals.dueToday > 0 ? '🟠 ' : '';

    rows.push({
      type: 'TableRow',
      style: 'emphasis',
      cells: [
        { type: 'TableCell', items: [{ type: 'TextBlock', text: 'TOTAL', weight: 'bolder' }] },
        { type: 'TableCell', items: [{ type: 'TextBlock', text: String(totals.pending), weight: 'bolder' }] },
        { type: 'TableCell', items: [{ type: 'TextBlock', text: `${totalLateEmoji}${totals.late}`, weight: 'bolder', color: totals.late > 0 ? 'attention' : 'default' }] },
        { type: 'TableCell', items: [{ type: 'TextBlock', text: `${totalTodayEmoji}${totals.dueToday}`, weight: 'bolder', color: totals.dueToday > 0 ? 'warning' : 'default' }] },
        { type: 'TableCell', items: [{ type: 'TextBlock', text: String(totals.dueTomorrow), weight: 'bolder' }] },
        { type: 'TableCell', items: [{ type: 'TextBlock', text: String(totals.upcoming), weight: 'bolder' }] }
      ]
    });

    const urgentText = totals.late > 0 || totals.dueToday > 0
      ? `⚠️ **${totals.late} late** + **${totals.dueToday} due today** = ${totals.late + totals.dueToday} orders need immediate attention!`
      : '✅ No urgent orders today.';

    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text: `📦 Order Lateness Report - ${today.toLocaleDateString()}`,
          weight: 'bolder',
          size: 'large'
        },
        {
          type: 'TextBlock',
          text: urgentText,
          wrap: true,
          color: totals.late > 0 ? 'attention' : 'good'
        },
        {
          type: 'Table',
          gridStyle: 'accent',
          firstRowAsHeader: true,
          columns: [
            { width: 2 },
            { width: 1 },
            { width: 1 },
            { width: 1 },
            { width: 1 },
            { width: 1 }
          ],
          rows: [
            {
              type: 'TableRow',
              style: 'accent',
              cells: [
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Channel', weight: 'bolder' }] },
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Pending', weight: 'bolder' }] },
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Late', weight: 'bolder' }] },
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Today', weight: 'bolder' }] },
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Tomorrow', weight: 'bolder' }] },
                { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Upcoming', weight: 'bolder' }] }
              ]
            },
            ...rows
          ]
        },
        {
          type: 'TextBlock',
          text: '_Excel report with all late orders attached._',
          size: 'small',
          isSubtle: true
        }
      ]
    };
  }

  /**
   * Send alert to Teams channel via webhook
   */
  async sendToChannel(webhookUrl = null) {
    await this.init();

    const targetWebhook = webhookUrl || process.env.TEAMS_LATE_ORDERS_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    if (!targetWebhook) {
      throw new Error('No Teams webhook URL configured');
    }

    const service = new TeamsNotificationService({ webhookUrl: targetWebhook });

    // Gather data
    const { orders, channelStats, today } = await this.gatherOrderData();

    // Build card
    const card = this.buildTeamsCard(channelStats, today);

    // Send message
    const result = await service.sendMessage(card);

    // Note: Webhooks don't support file attachments directly
    // The Excel needs to be uploaded to SharePoint/OneDrive and linked

    return {
      success: result.success,
      summary: channelStats,
      lateCount: Object.values(channelStats).reduce((sum, ch) => sum + (ch?.late || 0), 0),
      dueTodayCount: Object.values(channelStats).reduce((sum, ch) => sum + (ch?.dueToday || 0), 0)
    };
  }

  /**
   * Send alert to individual user(s) via MS Graph API
   */
  async sendToUsers(userEmails) {
    await this.init();

    if (!this.msGraph) {
      throw new Error('MS Graph API not configured. Required: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET');
    }

    // Gather data
    const { orders, channelStats, today } = await this.gatherOrderData();

    // Generate Excel
    const excelBuffer = await this.generateExcel(orders);

    // Upload Excel to OneDrive
    const fileName = `Late_Orders_Report_${today.toISOString().split('T')[0]}.xlsx`;
    let fileUrl = null;

    try {
      // Upload to default user's OneDrive
      const uploadResult = await this.msGraph.uploadFile(fileName, excelBuffer, 'Agent5Reports');
      if (uploadResult?.webUrl) {
        fileUrl = uploadResult.webUrl;
      }
    } catch (uploadError) {
      console.error('[LateOrdersAlert] Failed to upload Excel:', uploadError.message);
    }

    const results = [];

    for (const email of userEmails) {
      try {
        // Create or get 1:1 chat with user
        const chat = await this.msGraph._request('POST', '/chats', {
          chatType: 'oneOnOne',
          members: [
            {
              '@odata.type': '#microsoft.graph.aadUserConversationMember',
              roles: ['owner'],
              'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${process.env.MS_USER_ID}`
            },
            {
              '@odata.type': '#microsoft.graph.aadUserConversationMember',
              roles: ['owner'],
              'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${email}`
            }
          ]
        });

        const chatId = chat.id;

        // Build HTML message
        const totals = { late: 0, dueToday: 0, pending: 0 };
        Object.values(channelStats).forEach(ch => {
          if (ch) {
            totals.late += ch.late || 0;
            totals.dueToday += ch.dueToday || 0;
            totals.pending += ch.pending || 0;
          }
        });

        let html = `<h2>📦 Order Lateness Report - ${today.toLocaleDateString()}</h2>`;
        html += `<p><b>${totals.late} late</b> + <b>${totals.dueToday} due today</b> orders need attention.</p>`;
        html += '<table border="1" cellpadding="5"><tr><th>Channel</th><th>Pending</th><th>Late</th><th>Today</th><th>Tomorrow</th></tr>';

        for (const ch of ['Amazon Seller', 'Amazon Vendor', 'BOL', 'Sales', 'Other']) {
          const d = channelStats[ch];
          if (!d || d.pending === 0) continue;
          html += `<tr><td>${ch}</td><td>${d.pending}</td><td style="color:red">${d.late}</td><td style="color:orange">${d.dueToday}</td><td>${d.dueTomorrow}</td></tr>`;
        }
        html += '</table>';

        if (fileUrl) {
          html += `<p><a href="${fileUrl}">📊 Download Excel Report</a></p>`;
        }

        // Send message
        await this.msGraph.sendChatMessage(chatId, html, 'html');

        results.push({ email, success: true });
      } catch (error) {
        console.error(`[LateOrdersAlert] Failed to send to ${email}:`, error.message);
        results.push({ email, success: false, error: error.message });
      }
    }

    return {
      success: results.every(r => r.success),
      results,
      fileUrl,
      summary: channelStats
    };
  }

  /**
   * Get Excel file buffer (for API download)
   */
  async getExcelReport() {
    const { orders } = await this.gatherOrderData();
    return await this.generateExcel(orders);
  }

  /**
   * Get current status without sending
   */
  async getStatus() {
    const { orders, channelStats, today } = await this.gatherOrderData();

    const totals = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0 };
    Object.values(channelStats).forEach(ch => {
      if (ch) {
        for (const k of Object.keys(totals)) {
          totals[k] += ch[k] || 0;
        }
      }
    });

    return {
      date: today.toISOString(),
      channelStats,
      totals,
      lateOrders: orders.filter(o => o.status === 'late').map(o => ({
        picking: o.pickingName,
        order: o.saleOrderName,
        channel: o.channel,
        customer: o.customer,
        daysLate: o.daysLate,
        odooUrl: o.odooUrl
      }))
    };
  }
}

// Singleton
let instance = null;

function getLateOrdersAlertService() {
  if (!instance) {
    instance = new LateOrdersAlertService();
  }
  return instance;
}

module.exports = {
  LateOrdersAlertService,
  getLateOrdersAlertService
};
