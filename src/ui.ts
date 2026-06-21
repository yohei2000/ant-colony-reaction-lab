import { TOOL_DEFINITIONS } from './game/constants';
import {
  ENEMY_COLONIES,
  TACTICS,
  getUnlockedEnemies,
  previewBattle,
  resolveBattle
} from './game/battle';
import { saveColonyState } from './game/persistence';
import { setSelectedTool } from './game/state';
import {
  UPGRADE_DEFINITIONS,
  getMissingRequirements,
  getRuntimeStats,
  getUpgradeCost,
  getUpgradeLevel,
  purchaseUpgrade
} from './game/upgrades';
import type { EnemyId, GameState, TacticId, ToolType, UpgradeCategory, UpgradeId } from './game/types';

type DirtyCallback = () => void;

export class UIController {
  private activeTab: UpgradeCategory | 'expedition' = 'growth';
  private selectedEnemy: EnemyId = 'weak';
  private selectedTactic: TacticId = 'standard';
  private assignedSoldiers = 1;
  private lastRenderKey = '';

  constructor(
    private readonly state: GameState,
    private readonly onDirty: DirtyCallback,
    private readonly statsEl: HTMLElement,
    private readonly toolbarEl: HTMLElement,
    private readonly tabContentEl: HTMLElement,
    private readonly uiRoot: HTMLElement
  ) {
    this.renderToolbar();
    this.bindEvents();
    this.render(true);
  }

  render(force = false): void {
    const cooldown = Math.max(0, this.state.colony.battleCooldownUntil - Date.now());
    const renderKey = JSON.stringify({
      tool: this.state.selectedTool,
      tab: this.activeTab,
      food: Math.floor(this.state.colony.food * 10),
      ants: Math.floor(this.state.colony.antPopulation),
      wounded: Math.floor(this.state.colony.woundedAnts * 10),
      threat: Math.floor(this.state.colony.enemyThreat * 10),
      territory: this.state.colony.territory,
      soldier: this.state.colony.soldierAnts,
      cooldown: Math.ceil(cooldown / 1000),
      upgrades: this.state.colony.upgrades,
      unlocked: this.state.colony.unlockedEnemyColonies,
      selectedEnemy: this.selectedEnemy,
      selectedTactic: this.selectedTactic,
      assigned: this.assignedSoldiers
    });
    if (!force && renderKey === this.lastRenderKey) {
      return;
    }
    this.lastRenderKey = renderKey;
    this.renderStats();
    this.renderToolbar();
    this.renderActiveTab();
  }

  private renderStats(): void {
    const stats = getRuntimeStats(this.state.colony);
    const colony = this.state.colony;
    const entries = [
      ['食料', formatNumber(colony.food)],
      ['蟻数 / 上限', `${Math.floor(colony.antPopulation)} / ${stats.capacity}`],
      ['食料/秒', formatNumber(stats.foodPerSecond, 2)],
      ['巣Lv', String(colony.nestLevel)],
      ['領土', String(colony.territory)],
      ['敵脅威', formatNumber(colony.enemyThreat, 1)],
      ['兵隊', String(colony.soldierAnts)],
      ['負傷', String(Math.ceil(colony.woundedAnts))],
      ['働き蟻', String(stats.workingAnts)],
      ['増加/分', formatNumber(stats.antsPerMinute, 2)]
    ];
    this.statsEl.innerHTML = entries
      .map(
        ([label, value]) => `
          <div class="stat">
            <span class="stat-label">${label}</span>
            <span class="stat-value">${value}</span>
          </div>
        `
      )
      .join('');
  }

  private renderToolbar(): void {
    this.toolbarEl.innerHTML = TOOL_DEFINITIONS.map((tool) => {
      const active = this.state.selectedTool === tool.id ? ' is-active' : '';
      return `
        <button class="tool-button${active}" data-tool="${tool.id}" type="button" aria-pressed="${active ? 'true' : 'false'}">
          <span class="tool-icon ${tool.icon}"></span>
          <span>${tool.label}</span>
        </button>
      `;
    }).join('');
  }

  private renderActiveTab(): void {
    const tabButtons = this.uiRoot.querySelectorAll<HTMLButtonElement>('.tab-button');
    tabButtons.forEach((button) => {
      const tab = button.dataset.tab;
      button.classList.toggle('is-active', tab === this.tabNameForActive());
    });

    if (this.activeTab === 'expedition') {
      this.renderExpeditionTab();
      return;
    }
    this.renderUpgradeTab(this.activeTab);
  }

  private renderUpgradeTab(category: UpgradeCategory): void {
    const cards = UPGRADE_DEFINITIONS.filter((definition) => definition.category === category)
      .map((definition) => {
        const level = getUpgradeLevel(this.state.colony, definition.id);
        const cost = getUpgradeCost(this.state.colony, definition);
        const missing = getMissingRequirements(this.state.colony, definition);
        const ready = missing.length === 0;
        const levelText = level >= definition.maxLevel ? 'MAX' : `Lv ${level}/${definition.maxLevel}`;
        return `
          <article class="upgrade-card ${ready ? 'is-ready' : ''}">
            <div class="upgrade-header">
              <div>
                <div class="upgrade-title">${definition.name} <span>${levelText}</span></div>
                <div class="upgrade-effect">${definition.description}</div>
                <div class="upgrade-need">${ready ? `必要食料 ${cost}` : missing.join(' / ')}</div>
              </div>
              <button class="buy-button" type="button" data-upgrade="${definition.id}" ${ready ? '' : 'disabled'}>
                強化
              </button>
            </div>
          </article>
        `;
      })
      .join('');
    this.tabContentEl.innerHTML = `<div class="upgrade-list">${cards}</div>`;
  }

  private renderExpeditionTab(): void {
    const unlocked = getUnlockedEnemies(this.state.colony);
    if (!unlocked.some((enemy) => enemy.id === this.selectedEnemy)) {
      this.selectedEnemy = unlocked[0]?.id ?? 'weak';
    }
    const stats = getRuntimeStats(this.state.colony);
    this.assignedSoldiers = Math.max(0, Math.min(this.assignedSoldiers, stats.availableSoldiers));
    if (this.assignedSoldiers === 0 && stats.availableSoldiers > 0) {
      this.assignedSoldiers = 1;
    }
    const preview = previewBattle(
      this.state.colony,
      this.selectedEnemy,
      this.assignedSoldiers,
      this.selectedTactic
    );
    const cooldownText =
      preview.cooldownRemainingMs > 0
        ? `${Math.ceil(preview.cooldownRemainingMs / 1000)}秒`
        : '出撃可能';
    const enemyOptions = ENEMY_COLONIES.map((enemy) => {
      const unlockedEnemy = this.state.colony.unlockedEnemyColonies.includes(enemy.id);
      return `<option value="${enemy.id}" ${enemy.id === this.selectedEnemy ? 'selected' : ''} ${
        unlockedEnemy ? '' : 'disabled'
      }>${enemy.name}${unlockedEnemy ? '' : '（未解放）'}</option>`;
    }).join('');
    const logEntries = this.state.colony.battleLog
      .slice(0, 5)
      .map((log) => {
        const enemy = ENEMY_COLONIES.find((entry) => entry.id === log.enemyId);
        const tactic = TACTICS.find((entry) => entry.id === log.tacticId);
        return `
          <div class="log-entry">
            ${log.win ? '勝利' : '敗北'} / ${enemy?.name ?? log.enemyId} / ${tactic?.name ?? log.tacticId}
            食料 ${signed(log.foodDelta)} 領土 ${signed(log.territoryDelta)} 負傷 +${log.woundedDelta}
          </div>
        `;
      })
      .join('');

    this.tabContentEl.innerHTML = `
      <div class="battle-layout">
        <article class="battle-card">
          <div class="battle-grid">
            <div class="battle-field">
              <label for="enemy-select">敵選択</label>
              <select id="enemy-select" data-enemy-select>${enemyOptions}</select>
            </div>
            <div class="battle-field">
              <label for="soldier-input">出撃兵数 / ${stats.availableSoldiers}</label>
              <input id="soldier-input" data-soldier-input type="number" min="0" max="${stats.availableSoldiers}" value="${this.assignedSoldiers}" inputmode="numeric" />
            </div>
          </div>
          <div class="battle-field">
            <label>戦術</label>
            <div class="tactic-row">
              ${TACTICS.map(
                (tactic) => `
                  <button class="tactic-button ${tactic.id === this.selectedTactic ? 'is-active' : ''}" type="button" data-tactic="${tactic.id}">
                    ${tactic.name}
                  </button>
                `
              ).join('')}
            </div>
          </div>
          <div class="battle-meta">
            勝率 ${Math.round(preview.winChance * 100)}% / 自軍戦力 ${formatNumber(preview.playerPower, 1)}
            / 敵戦力 ${formatNumber(preview.enemyPower, 1)}<br />
            報酬 食料 ${preview.rewardFood}・領土 ${preview.rewardTerritory}
            / 想定損害 ${preview.expectedWounded} / クールダウン ${cooldownText}
          </div>
          <button class="battle-button" type="button" data-battle-start ${
            preview.cooldownRemainingMs > 0 || preview.assignedSoldiers <= 0 ? 'disabled' : ''
          }>
            遠征開始
          </button>
        </article>
        <article class="battle-card">
          <div class="battle-title">戦闘ログ</div>
          ${logEntries || '<div class="log-entry">まだ遠征記録はありません</div>'}
        </article>
      </div>
    `;
  }

  private bindEvents(): void {
    this.toolbarEl.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
      if (!button) {
        return;
      }
      setSelectedTool(this.state, button.dataset.tool as ToolType);
      this.render(true);
    });

    this.uiRoot.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tabButton = target.closest<HTMLButtonElement>('[data-tab]');
      if (tabButton) {
        const tab = tabButton.dataset.tab;
        this.activeTab = tab === 'upgrade' ? 'combat' : tab === 'expedition' ? 'expedition' : 'growth';
        this.render(true);
        return;
      }

      const upgradeButton = target.closest<HTMLButtonElement>('[data-upgrade]');
      if (upgradeButton) {
        const purchased = purchaseUpgrade(this.state.colony, upgradeButton.dataset.upgrade as UpgradeId);
        if (purchased) {
          saveColonyState(this.state.colony);
          this.onDirty();
          this.render(true);
        }
        return;
      }

      const tacticButton = target.closest<HTMLButtonElement>('[data-tactic]');
      if (tacticButton) {
        this.selectedTactic = tacticButton.dataset.tactic as TacticId;
        this.render(true);
        return;
      }

      const battleButton = target.closest<HTMLButtonElement>('[data-battle-start]');
      if (battleButton) {
        const result = resolveBattle(
          this.state.colony,
          this.selectedEnemy,
          this.assignedSoldiers,
          this.selectedTactic
        );
        if (result) {
          saveColonyState(this.state.colony);
          this.onDirty();
          this.render(true);
        }
      }
    });

    this.uiRoot.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches('[data-enemy-select]')) {
        this.selectedEnemy = target.value as EnemyId;
        this.render(true);
      }
      if (target.matches('[data-soldier-input]')) {
        const available = getRuntimeStats(this.state.colony).availableSoldiers;
        this.assignedSoldiers = Math.max(0, Math.min(Number(target.value) || 0, available));
        this.render(true);
      }
    });
  }

  private tabNameForActive(): string {
    return this.activeTab === 'combat'
      ? 'upgrade'
      : this.activeTab === 'expedition'
        ? 'expedition'
        : 'growth';
  }
}

function formatNumber(value: number, fractionDigits = 0): string {
  return value.toLocaleString('ja-JP', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits
  });
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}
