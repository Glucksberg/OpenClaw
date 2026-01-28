#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FP_FILE = path.join(__dirname, '../false-positives.json');

class FalsePositiveManager {
  constructor(customPath = null) {
    this.fpFile = customPath || FP_FILE;
    this.data = this.loadData();
    this.regexCache = new Map(); // Performance: Cache compiled regexes
    this.recentErrors = new Map(); // Rate limiting tracking
  }

  loadData() {
    if (!fs.existsSync(this.fpFile)) {
      return {
        false_positives: {},
        metadata: {
          created: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          total_entries: 0,
          version: "1.1"
        },
        config: {
          auto_classify_threshold: 3,
          max_history_entries: 100,
          cooldown_minutes: 15,
          recent_errors_window_minutes: 15
        }
      };
    }
    
    try {
      const data = JSON.parse(fs.readFileSync(this.fpFile, 'utf8'));
      // Migrate older versions if needed
      if (!data.config.recent_errors_window_minutes) {
        data.config.recent_errors_window_minutes = 15;
      }
      return data;
    } catch (error) {
      console.error('Failed to load false positives data:', error);
      throw error;
    }
  }

  // Security & Data Integrity: Atomic file writes
  saveData() {
    try {
      this.data.metadata.last_updated = new Date().toISOString();
      const tempFile = this.fpFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2));
      fs.renameSync(tempFile, this.fpFile); // Atomic write
    } catch (error) {
      console.error('Failed to save false positives data:', error);
      throw error;
    }
  }

  // Validation: Sanitize and validate inputs
  _validatePattern(pattern) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('Pattern must be a non-empty string');
    }
    
    try {
      new RegExp(pattern, 'i'); // Test if pattern is valid
      return true;
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${pattern} - ${error.message}`);
    }
  }

  _validateId(id) {
    if (typeof id !== 'string' || !/^[A-Z0-9-_]+$/.test(id)) {
      throw new Error('ID must contain only uppercase letters, numbers, hyphens, and underscores');
    }
  }

  // Performance: Get compiled regex from cache
  _getCompiledRegex(id, pattern) {
    if (!this.regexCache.has(id)) {
      try {
        this.regexCache.set(id, new RegExp(pattern, 'i'));
      } catch (error) {
        console.warn(`Invalid regex pattern for ${id}: ${pattern}`);
        return null;
      }
    }
    return this.regexCache.get(id);
  }

  // ML-Ready: Track recent errors for auto-classification
  _trackRecentError(errorMessage) {
    const hash = crypto.createHash('md5').update(errorMessage).digest('hex');
    const now = Date.now();
    const windowMs = this.data.config.recent_errors_window_minutes * 60 * 1000;
    
    if (!this.recentErrors.has(hash)) {
      this.recentErrors.set(hash, []);
    }
    
    const recent = this.recentErrors.get(hash);
    recent.push(now);
    
    // Clean old entries
    this.recentErrors.set(hash, recent.filter(timestamp => now - timestamp < windowMs));
    
    return this.recentErrors.get(hash).length;
  }

  // Auto-classification: Detect if error should become FP
  shouldAutoClassify(errorMessage) {
    const recentCount = this._trackRecentError(errorMessage);
    return recentCount >= this.data.config.auto_classify_threshold;
  }

  // Enhanced: Add with full validation
  add(id, name, description, pattern, options = {}) {
    this._validateId(id);
    this._validatePattern(pattern);

    if (this.data.false_positives[id]) {
      throw new Error(`False positive with ID '${id}' already exists`);
    }

    const fp = {
      id,
      name: String(name || ''),
      description: String(description || ''),
      pattern,
      severity: options.severity || 'medium',
      auto_resolve: Boolean(options.auto_resolve),
      count: 1,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      affected_processes: Array.isArray(options.affected_processes) ? options.affected_processes : [],
      user_triggers: Array.isArray(options.user_triggers) ? options.user_triggers : [],
      mitigation: String(options.mitigation || ''),
      notes: String(options.notes || ''),
      history: [{
        timestamp: new Date().toISOString(),
        reported_by: options.reported_by || 'manual',
        context: String(options.context || ''),
        resolved: Boolean(options.resolved),
        resolution_method: options.resolution_method || 'manual'
      }]
    };

    this.data.false_positives[id] = fp;
    this.data.metadata.total_entries = Object.keys(this.data.false_positives).length;
    
    // Update cache
    this._getCompiledRegex(id, pattern);
    
    this.saveData();
    return fp;
  }

  // Enhanced: Increment with validation
  increment(id, context = '', resolved = false, resolutionMethod = 'auto') {
    const fp = this.data.false_positives[id];
    if (!fp) {
      console.warn(`False positive '${id}' not found for increment`);
      return null;
    }

    fp.count++;
    fp.last_seen = new Date().toISOString();
    
    // Add to history
    fp.history.push({
      timestamp: new Date().toISOString(),
      reported_by: 'auto_detection',
      context: String(context),
      resolved: Boolean(resolved),
      resolution_method: resolutionMethod
    });

    // Maintain history size limit
    if (fp.history.length > this.data.config.max_history_entries) {
      fp.history = fp.history.slice(-this.data.config.max_history_entries);
    }

    this.saveData();
    return fp;
  }

  // Security & Performance: Enhanced pattern matching
  checkMatch(errorMessage, processName = '') {
    if (!errorMessage || typeof errorMessage !== 'string') {
      return null;
    }

    for (const [id, fp] of Object.entries(this.data.false_positives)) {
      const regex = this._getCompiledRegex(id, fp.pattern);
      if (!regex) continue; // Skip invalid patterns
      
      try {
        if (regex.test(errorMessage)) {
          // Verify process match if specified
          if (fp.affected_processes.length > 0 && processName && 
              !fp.affected_processes.includes(processName)) {
            continue;
          }
          return { id, fp };
        }
      } catch (error) {
        console.warn(`Error testing pattern for ${id}:`, error);
        continue;
      }
    }
    return null;
  }

  // Enhanced: List with sorting options
  list(sortBy = 'count', order = 'desc') {
    const fps = Object.values(this.data.false_positives);
    
    return fps.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];
      
      if (sortBy === 'last_seen' || sortBy === 'first_seen') {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      }
      
      if (order === 'desc') {
        return bVal > aVal ? 1 : -1;
      } else {
        return aVal > bVal ? 1 : -1;
      }
    });
  }

  // Enhanced: Detailed statistics
  getStats() {
    const fps = Object.values(this.data.false_positives);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    return {
      total: fps.length,
      total_occurrences: fps.reduce((sum, fp) => sum + fp.count, 0),
      most_frequent: fps.sort((a, b) => b.count - a.count)[0]?.id || 'none',
      auto_resolvable: fps.filter(fp => fp.auto_resolve).length,
      recent_24h: fps.filter(fp => now - new Date(fp.last_seen).getTime() < dayMs).length,
      by_severity: {
        critical: fps.filter(fp => fp.severity === 'critical').length,
        high: fps.filter(fp => fp.severity === 'high').length,
        medium: fps.filter(fp => fp.severity === 'medium').length,
        low: fps.filter(fp => fp.severity === 'low').length
      }
    };
  }

  // ML-Ready: Export training data
  exportTrainingData() {
    return this.list().map(fp => ({
      pattern: fp.pattern,
      description: fp.description,
      user_triggers: fp.user_triggers,
      count: fp.count,
      auto_resolve: fp.auto_resolve,
      severity: fp.severity,
      avg_occurrences_per_day: this._calculateAvgOccurrencesPerDay(fp)
    }));
  }

  _calculateAvgOccurrencesPerDay(fp) {
    const first = new Date(fp.first_seen).getTime();
    const last = new Date(fp.last_seen).getTime();
    const daysDiff = Math.max(1, (last - first) / (24 * 60 * 60 * 1000));
    return (fp.count / daysDiff).toFixed(2);
  }

  // Integration: Generate Slack/Discord alerts
  generateSlackAlert(fpMatch) {
    return {
      text: `❌ Falso positivo ${fpMatch.id} detectado`,
      attachments: [{
        color: fpMatch.fp.severity === 'high' || fpMatch.fp.severity === 'critical' ? 'danger' : 'warning',
        fields: [
          { title: 'Ocorrências', value: fpMatch.fp.count.toString(), short: true },
          { title: 'Auto-resolve', value: fpMatch.fp.auto_resolve ? '✅' : '❌', short: true },
          { title: 'Última vez', value: new Date(fpMatch.fp.last_seen).toLocaleString(), short: true },
          { title: 'Severidade', value: fpMatch.fp.severity, short: true }
        ],
        footer: fpMatch.fp.description
      }]
    };
  }

  // Enhanced: Rich report generation
  generateReport(includeHistory = false) {
    const stats = this.getStats();
    const fps = this.list();
    
    let report = `🔒 *Relatório de Falsos Positivos*\n\n`;
    report += `📊 *Estatísticas Gerais*:\n`;
    report += `• Total de tipos: ${stats.total}\n`;
    report += `• Total de ocorrências: ${stats.total_occurrences}\n`;
    report += `• Auto-resolvíveis: ${stats.auto_resolvable}\n`;
    report += `• Ativos nas últimas 24h: ${stats.recent_24h}\n\n`;

    report += `⚠️ *Por Severidade*:\n`;
    report += `• Critical: ${stats.by_severity.critical}\n`;
    report += `• High: ${stats.by_severity.high}\n`;
    report += `• Medium: ${stats.by_severity.medium}\n`;
    report += `• Low: ${stats.by_severity.low}\n\n`;

    if (fps.length > 0) {
      report += `📋 *Top 5 Mais Frequentes*:\n`;
      fps.slice(0, 5).forEach((fp, i) => {
        const lastSeen = new Date(fp.last_seen).toLocaleDateString();
        report += `${i+1}. **${fp.id}** (${fp.count}x) - ${fp.severity}\n`;
        report += `   └ ${fp.description}\n`;
        report += `   └ Última: ${lastSeen}\n`;
        
        if (includeHistory && fp.history.length > 1) {
          report += `   └ Histórico recente: ${fp.history.slice(-3).map(h => 
            new Date(h.timestamp).toLocaleDateString()).join(', ')}\n`;
        }
        report += '\n';
      });
    }

    return report;
  }

  // Utility: Clean up old data
  cleanup(olderThanDays = 30) {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let removed = 0;
    
    for (const [id, fp] of Object.entries(this.data.false_positives)) {
      if (new Date(fp.last_seen) < cutoff) {
        delete this.data.false_positives[id];
        this.regexCache.delete(id);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.data.metadata.total_entries = Object.keys(this.data.false_positives).length;
      this.saveData();
    }
    
    return removed;
  }
}

// Enhanced CLI interface
if (require.main === module) {
  const manager = new FalsePositiveManager();
  const command = process.argv[2];

  try {
    switch (command) {
      case 'list':
        const sortBy = process.argv[3] || 'count';
        const order = process.argv[4] || 'desc';
        console.log(JSON.stringify(manager.list(sortBy, order), null, 2));
        break;
        
      case 'stats':
        console.log(JSON.stringify(manager.getStats(), null, 2));
        break;
        
      case 'report':
        const includeHistory = process.argv[3] === '--history';
        console.log(manager.generateReport(includeHistory));
        break;
        
      case 'check':
        const message = process.argv[3] || '';
        const processName = process.argv[4] || '';
        const match = manager.checkMatch(message, processName);
        console.log(JSON.stringify(match, null, 2));
        break;
        
      case 'add':
        const [, , , id, name, desc, pattern, ...optionArgs] = process.argv;
        if (!id || !name || !desc || !pattern) {
          console.error('Usage: add <id> <name> <description> <pattern> [--auto-resolve] [--severity=level]');
          process.exit(1);
        }
        
        const options = {};
        optionArgs.forEach(arg => {
          if (arg === '--auto-resolve') options.auto_resolve = true;
          if (arg.startsWith('--severity=')) options.severity = arg.split('=')[1];
        });
        
        const newFp = manager.add(id, name, desc, pattern, options);
        console.log(`✅ Added false positive: ${newFp.id}`);
        break;
        
      case 'increment':
        const fpId = process.argv[3];
        const context = process.argv[4] || '';
        if (!fpId) {
          console.error('Usage: increment <id> [context]');
          process.exit(1);
        }
        const updated = manager.increment(fpId, context, true, 'manual');
        if (updated) {
          console.log(`✅ Incremented ${fpId}: now ${updated.count} occurrences`);
        } else {
          console.error(`❌ False positive '${fpId}' not found`);
          process.exit(1);
        }
        break;
        
      case 'export':
        console.log(JSON.stringify(manager.exportTrainingData(), null, 2));
        break;
        
      case 'cleanup':
        const days = parseInt(process.argv[3]) || 30;
        const removed = manager.cleanup(days);
        console.log(`🧹 Removed ${removed} old false positives (older than ${days} days)`);
        break;
        
      default:
        console.log(`Usage: node false-positive-manager.cjs <command>

Commands:
  list [sortBy] [order]     - List false positives (sortBy: count|last_seen|severity)
  stats                     - Show statistics
  report [--history]        - Generate formatted report
  check <message> [process] - Check if message matches known false positive
  add <id> <name> <desc> <pattern> [--auto-resolve] [--severity=level]
  increment <id> [context]  - Manually increment counter
  export                    - Export ML training data
  cleanup [days]            - Remove old false positives (default: 30 days)`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = FalsePositiveManager;