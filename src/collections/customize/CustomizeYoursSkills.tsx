import { Pictogram } from "../../ui/Pictogram";
import { SkeletonRows, LoadError, SkillRow } from "./CustomizeRows";
import { sections } from "./customize-list";
import { t, formatText } from "../../i18n";
import type { View, OpenMenu } from "./CustomizePage";
import type { CustomizeSkill } from "../../../shared/collections-api";
import type { StarterSkill } from "./starter-skills";
import type { SkillOrigin } from "./customize-list";

/** What CustomizeYoursSkills needs from CustomizeView.tsx. */
export interface CustomizePart3Props {
  changeView: (next: View) => void;
  loadSkills: () => Promise<void>;
  menu: OpenMenu | undefined;
  openSkill: (skill: CustomizeSkill | StarterSkill) => void;
  origin: SkillOrigin;
  own: CustomizeSkill[];
  rowAnchor: React.RefObject<HTMLElement | null>;
  searching: boolean;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setOrigin: React.Dispatch<React.SetStateAction<SkillOrigin>>;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  skills: CustomizeSkill[] | undefined;
  skillsError: boolean;
  yours: CustomizeSkill[];
}

export function CustomizeYoursSkills({
  changeView,
  loadSkills,
  menu,
  openSkill,
  origin,
  own,
  rowAnchor,
  searching,
  setMenu,
  setOrigin,
  setQuery,
  skills,
  skillsError,
  yours,
}: CustomizePart3Props) {
  return (
    <>
      {skills !== undefined &&
        !skillsError &&
        !own.length &&
        origin === "all" &&
        !searching && (
          <section className="customize-callout customize-yours-callout">
            <div>
              <h3>Add your first skills</h3>
              <p>
                Skills teach Claudex how you work. Add them from Discover, or
                create your own.
              </p>
              <button type="button" onClick={() => changeView("discover")}>
                Discover skills
              </button>
            </div>
            <Pictogram name="ObjectPaperAirplane" size={64} />
          </section>
        )}
      {skills === undefined ? (
        <SkeletonRows label="Loading skills" />
      ) : skillsError ? (
        <LoadError
          message="Couldn’t load your skills."
          onRetry={() => void loadSkills()}
        />
      ) : !yours.length && (origin !== "all" || searching) ? (
        <div className="customize-filter-empty" role="status">
          <Pictogram name="ObjectMagnifier" />
          <p>Nothing matches these filters.</p>
          <button
            type="button"
            onClick={() => {
              // O16 c5e558aae:881 clears filters only; the menu's
              // separate Reset filters and sort also restores sort.
              setOrigin("all");
              setQuery(null);
            }}
          >
            Reset filters
          </button>
        </div>
      ) : (
        sections.map((section) => {
          const rows = yours.filter(section.test);
          return rows.length ? (
            <section key={section.id} className="customize-section">
              <h3>
                {t(section.title)}
                <span
                  className="customize-section-count"
                  aria-label={formatText("{count} skills", {
                    count: rows.length,
                  })}
                >
                  {rows.length}
                </span>
              </h3>
              <ul className="customize-rows">
                {rows.map((skill) => (
                  <SkillRow
                    key={skill.path}
                    skill={skill}
                    from={section.from}
                    menuOpen={
                      menu?.kind === "row" && menu.skill?.path === skill.path
                    }
                    onOpen={() => openSkill(skill)}
                    onMenu={(button) => {
                      rowAnchor.current = button;
                      setMenu(
                        menu?.kind === "row" && menu.skill?.path === skill.path
                          ? undefined
                          : {
                              kind: "row",
                              rect: button.getBoundingClientRect(),
                              skill,
                            },
                      );
                    }}
                  />
                ))}
              </ul>
            </section>
          ) : null;
        })
      )}
    </>
  );
}
