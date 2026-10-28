import { useState } from "react";
import { Plug, Wrench, Plus } from "../../ui/glyphs";
import type { PluginEntry } from "../../../shared/collections-api";

/**
 * The Code + menu's Plugins: the enabled plugins, a rule, then Manage plugins
 * and Browse plugins. A plugin's row opens it in Settings → Plugins.
 */
export function CodePluginSubmenu({
  plugins,
  onOpen,
  onManage,
  onBrowse,
}: {
  plugins: PluginEntry[];
  onOpen: (plugin: PluginEntry) => void;
  onManage: () => void;
  onBrowse: () => void;
}) {
  const [active, setActive] = useState(0);
  const row = (index: number) => ({
    "data-active": active === index,
    onMouseEnter: () => setActive(index),
    onFocus: () => setActive(index),
  });
  return (
    <div className="code-add-submenu" role="menu" aria-label="Plugins">
      {plugins.map((plugin, index) => (
        <button
          key={plugin.id}
          role="menuitem"
          {...row(index)}
          onClick={() => onOpen(plugin)}
        >
          <Plug className="code-add-plug" />
          <span data-no-translate>{plugin.title}</span>
        </button>
      ))}
      <div className="code-add-submenu-separator" role="separator" />
      <button role="menuitem" {...row(plugins.length)} onClick={onManage}>
        <Wrench />
        <span>Manage plugins</span>
      </button>
      <button role="menuitem" {...row(plugins.length + 1)} onClick={onBrowse}>
        <Plus />
        <span>Browse plugins</span>
      </button>
    </div>
  );
}
