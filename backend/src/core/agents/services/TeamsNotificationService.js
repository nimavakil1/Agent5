/**
 * Teams Notification Service
 *
 * Sends notifications to Microsoft Teams via incoming webhook.
 * Uses Adaptive Cards for rich formatting.
 *
 * @module TeamsNotificationService
 */

const https = require('https');
const url = require('url');

class TeamsNotificationService {
  constructor(config = {}) {
    this.webhookUrl = config.webhookUrl || process.env.TEAMS_WEBHOOK_URL;

    if (!this.webhookUrl) {
      console.warn('TeamsNotificationService: No webhook URL configured');
    }
  }

  /**
   * Send a message to Teams
   */
  async sendMessage(card) {
    if (!this.webhookUrl) {
      console.warn('Teams webhook not configured, skipping notification');
      return { success: false, reason: 'No webhook URL' };
    }

    const message = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card
        }
      ]
    };

    return this._postToWebhook(message);
  }

  /**
   * Send a simple text notification
   */
  async sendSimple(title, text, color = 'default') {
    const _colorMap = {
      default: '#0078D4',
      success: '#28A745',
      warning: '#FFC107',
      error: '#DC3545',
      info: '#17A2B8'
    };

    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'Container',
          style: color !== 'default' ? 'emphasis' : 'default',
          items: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'bolder',
              size: 'large',
              color: color
            },
            {
              type: 'TextBlock',
              text: text,
              wrap: true
            }
          ]
        }
      ]
    };

    return this.sendMessage(card);
  }

  /**
   * Send daily summary notification
   */
  async sendDailySummary(summary) {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: `📊 AI AGENTS DAILY SUMMARY - ${summary.date}`,
          weight: 'bolder',
          size: 'large'
        },
        {
          type: 'Container',
          separator: true,
          items: [
            {
              type: 'TextBlock',
              text: '🛒 PURCHASING AGENT',
              weight: 'bolder'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Products analyzed', value: String(summary.purchasing?.analyzed || 0) },
                { title: 'Reorder recommendations', value: String(summary.purchasing?.reorders || 0) },
                { title: 'CNY alerts', value: String(summary.purchasing?.cnyAlerts || 0) }
              ]
            }
          ]
        },
        {
          type: 'Container',
          separator: true,
          items: [
            {
              type: 'TextBlock',
              text: '📦 INVENTORY OPTIMIZATION',
              weight: 'bolder'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Slow-movers detected', value: String(summary.inventory?.slowMovers || 0) },
                { title: 'Experiments running', value: String(summary.inventory?.experimentsRunning || 0) },
                { title: 'Experiments completed', value: String(summary.inventory?.experimentsCompleted || 0) },
                { title: 'Red flags', value: String(summary.inventory?.redFlags || 0) }
              ]
            }
          ]
        },
        {
          type: 'Container',
          separator: true,
          items: [
            {
              type: 'TextBlock',
              text: '📋 ODOO TASKS',
              weight: 'bolder'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Created yesterday', value: String(summary.tasks?.created || 0) },
                { title: 'Completed yesterday', value: String(summary.tasks?.completed || 0) },
                { title: 'Overdue', value: String(summary.tasks?.overdue || 0) }
              ]
            }
          ]
        }
      ]
    };

    // Add pending approvals if any
    if (summary.pendingApprovals && summary.pendingApprovals.length > 0) {
      card.body.push({
        type: 'Container',
        separator: true,
        items: [
          {
            type: 'TextBlock',
            text: `⏳ PENDING APPROVALS (${summary.pendingApprovals.length})`,
            weight: 'bolder',
            color: 'attention'
          },
          ...summary.pendingApprovals.slice(0, 5).map(task => ({
            type: 'TextBlock',
            text: `• ${task.name}`,
            wrap: true
          }))
        ]
      });
    }

    // Add metrics if available
    if (summary.metrics) {
      card.body.push({
        type: 'Container',
        separator: true,
        items: [
          {
            type: 'TextBlock',
            text: '💰 METRICS',
            weight: 'bolder'
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Holding cost impact', value: `€${summary.metrics.holdingCostImpact || 0}` },
              { title: 'Experiment success rate', value: `${summary.metrics.experimentSuccessRate || 0}%` }
            ]
          }
        ]
      });
    }

    return this.sendMessage(card);
  }

  /**
   * Send task created notification
   */
  async sendTaskCreated(task) {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '🆕 New Agent Task Created',
          weight: 'bolder',
          size: 'large'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Task', value: task.name },
            { title: 'Product', value: task.productSku || 'N/A' },
            { title: 'Deadline', value: new Date(task.deadline).toLocaleDateString() },
            { title: 'Priority', value: task.priority === '3' ? 'Urgent' : task.priority === '2' ? 'High' : 'Normal' }
          ]
        },
        {
          type: 'TextBlock',
          text: task.description?.substring(0, 200) + '...' || '',
          wrap: true,
          size: 'small'
        }
      ]
    };

    return this.sendMessage(card);
  }

  /**
   * Send task reminder notification
   */
  async sendTaskReminder(task) {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '⏰ Task Reminder - Deadline Approaching',
          weight: 'bolder',
          size: 'large',
          color: 'warning'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Task', value: task.name },
            { title: 'Deadline', value: new Date(task.deadline).toLocaleDateString() },
            { title: 'Status', value: task.isOverdue ? 'OVERDUE' : 'Due Soon' }
          ]
        },
        {
          type: 'TextBlock',
          text: 'Please complete this task or request an extension.',
          wrap: true
        }
      ]
    };

    return this.sendMessage(card);
  }

  /**
   * Send slow-mover alert
   */
  async sendSlowMoverAlert(product) {
    const statusColors = {
      red_flag: 'attention',
      slow_mover: 'warning',
      normal: 'good'
    };

    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: product.status === 'red_flag' ? '🚨 RED FLAG - Immediate Action Required' : '⚠️ Slow-Moving Inventory Detected',
          weight: 'bolder',
          size: 'large',
          color: statusColors[product.status] || 'default'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Product', value: `${product.productSku} - ${product.productName}` },
            { title: 'Days of Stock', value: String(product.metrics.daysOfStock) },
            { title: 'Days Since Last Sale', value: String(product.metrics.daysSinceLastSale) },
            { title: 'Stock Value', value: `€${product.metrics.stockValue}` },
            { title: 'Monthly Holding Cost', value: `€${product.metrics.monthlyHoldingCost}` }
          ]
        }
      ]
    };

    // Add recommendations
    if (product.recommendations && product.recommendations.length > 0) {
      card.body.push({
        type: 'Container',
        separator: true,
        items: [
          {
            type: 'TextBlock',
            text: '📋 Recommendations:',
            weight: 'bolder'
          },
          ...product.recommendations.map(rec => ({
            type: 'TextBlock',
            text: `• ${rec.message}`,
            wrap: true
          }))
        ]
      });
    }

    return this.sendMessage(card);
  }

  /**
   * Send experiment update
   */
  async sendExperimentUpdate(experiment) {
    const statusEmoji = experiment.status === 'completed'
      ? (experiment.success ? '✅' : '❌')
      : '🔬';

    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: `${statusEmoji} Experiment ${experiment.status === 'completed' ? 'Completed' : 'Update'}`,
          weight: 'bolder',
          size: 'large'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Product', value: experiment.productSku },
            { title: 'Action', value: experiment.action },
            { title: 'Day', value: `${experiment.currentDay} of ${experiment.maxDays}` },
            { title: 'Sales Before', value: `${experiment.salesBefore} units/day` },
            { title: 'Sales Now', value: `${experiment.salesNow} units/day` },
            { title: 'Change', value: `${experiment.salesChange > 0 ? '+' : ''}${experiment.salesChange}%` }
          ]
        }
      ]
    };

    if (experiment.status === 'completed') {
      card.body.push({
        type: 'TextBlock',
        text: experiment.success
          ? '✅ Experiment successful - maintaining changes'
          : '❌ Experiment unsuccessful - considering further action',
        weight: 'bolder',
        color: experiment.success ? 'good' : 'attention'
      });
    }

    return this.sendMessage(card);
  }

  /**
   * POST to webhook
   */
  async _postToWebhook(message) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new url.URL(this.webhookUrl);
      const payload = JSON.stringify(message);

      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            resolve({ success: false, statusCode: res.statusCode, error: data });
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }
}

module.exports = { TeamsNotificationService };
