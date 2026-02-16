/** Usage chart — 7-day message + token chart */
export function usageChartStyles(): string {
  return `
    .chart-container {
      padding: 16px;
      height: 260px;
    }
  `;
}

export function usageChartHtml(): string {
  return `
      <div class="panel">
        <div class="panel-header">Usage (7 Days)</div>
        <div class="chart-container">
          <canvas id="usageChart"></canvas>
        </div>
      </div>`;
}

export function usageChartScript(): string {
  return `
    let usageChart = null;
    function initChart(messagesByDay, tokensByDay) {
      if (typeof Chart === 'undefined') return;
      const ctx = document.getElementById('usageChart');
      if (!ctx) return;

      const labels = messagesByDay.map(d => {
        const date = new Date(d.date + 'T00:00:00');
        return date.toLocaleDateString('en-US', { weekday: 'short' });
      });

      if (usageChart) usageChart.destroy();
      usageChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Messages',
              data: messagesByDay.map(d => d.count),
              backgroundColor: 'rgba(108, 99, 255, 0.6)',
              borderColor: 'rgba(108, 99, 255, 1)',
              borderWidth: 1,
              borderRadius: 4,
              yAxisID: 'y',
              order: 2,
            },
            {
              label: 'Claude Tokens',
              data: tokensByDay.map(d => d.mainTokens),
              type: 'line',
              borderColor: 'rgba(74, 222, 128, 0.8)',
              backgroundColor: 'rgba(74, 222, 128, 0.1)',
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: 'rgba(74, 222, 128, 1)',
              tension: 0.3,
              fill: true,
              yAxisID: 'y1',
              order: 1,
            },
            {
              label: 'Haiku Tokens',
              data: tokensByDay.map(d => d.haikuTokens),
              type: 'line',
              borderColor: 'rgba(250, 204, 21, 0.8)',
              backgroundColor: 'rgba(250, 204, 21, 0.08)',
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: 'rgba(250, 204, 21, 1)',
              tension: 0.3,
              fill: true,
              yAxisID: 'y1',
              order: 0,
            },
            {
              label: 'Watcher Tokens',
              data: tokensByDay.map(d => d.watcherTokens),
              type: 'line',
              borderColor: 'rgba(248, 113, 113, 0.8)',
              backgroundColor: 'rgba(248, 113, 113, 0.08)',
              borderWidth: 2,
              borderDash: [4, 3],
              pointRadius: 3,
              pointBackgroundColor: 'rgba(248, 113, 113, 1)',
              tension: 0.3,
              fill: false,
              yAxisID: 'y1',
              order: -1,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              labels: { color: '#888', font: { size: 11 }, boxWidth: 12 }
            }
          },
          scales: {
            x: {
              ticks: { color: '#555' },
              grid: { color: '#1e1e2e' }
            },
            y: {
              position: 'left',
              ticks: { color: '#6c63ff', stepSize: 1 },
              grid: { color: '#1e1e2e' },
              title: { display: true, text: 'Messages', color: '#555', font: { size: 11 } }
            },
            y1: {
              position: 'right',
              ticks: { color: '#4ade80', callback: v => fmtTokens(v) },
              grid: { drawOnChartArea: false },
              title: { display: true, text: 'Tokens', color: '#555', font: { size: 11 } }
            }
          }
        }
      });
    }
  `;
}
